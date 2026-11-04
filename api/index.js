// DuoSave Serverless API Handler for Vercel
// Supports 6-digit shared account codes and Upstash Redis / Vercel KV persistence

function uuid() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

const DEFAULT_SETTINGS = {
  partner1Name: "Partner 1",
  partner2Name: "Partner 2",
  monthlyTarget: 10000,
  currency: "RWF",
  accountName: "Joint Savings Account"
};

// Check if date is in the future (>60 seconds)
function isFutureDate(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr).getTime();
  const now = Date.now() + 60000;
  return d > now;
}

// Compute statistics and summary for an account
function computeSummary(data) {
  const settings = data.settings || DEFAULT_SETTINGS;
  const transactions = data.transactions || [];
  let partner1Deposits = 0;
  let partner2Deposits = 0;
  let totalDeposits = 0;
  let partner1LoansTaken = 0;
  let partner2LoansTaken = 0;
  let partner1LoansRepaid = 0;
  let partner2LoansRepaid = 0;

  transactions.forEach(tx => {
    const amt = Number(tx.amount) || 0;
    if (tx.type === 'deposit') {
      totalDeposits += amt;
      if (tx.partner === 'partner1') partner1Deposits += amt;
      else if (tx.partner === 'partner2') partner2Deposits += amt;
    } else if (tx.type === 'loan') {
      if (tx.partner === 'partner1') partner1LoansTaken += amt;
      else if (tx.partner === 'partner2') partner2LoansTaken += amt;
    } else if (tx.type === 'repayment') {
      if (tx.partner === 'partner1') partner1LoansRepaid += amt;
      else if (tx.partner === 'partner2') partner2LoansRepaid += amt;
    }
  });

  const totalLoansTaken = partner1LoansTaken + partner2LoansTaken;
  const totalLoansRepaid = partner1LoansRepaid + partner2LoansRepaid;
  const currentBankBalance = (totalDeposits + totalLoansRepaid) - totalLoansTaken;

  const partner1LoanBalance = Math.max(0, partner1LoansTaken - partner1LoansRepaid);
  const partner2LoanBalance = Math.max(0, partner2LoansTaken - partner2LoansRepaid);
  const totalOutstandingLoans = partner1LoanBalance + partner2LoanBalance;

  const currentMonthKey = new Date().toISOString().slice(0, 7);

  const getMonthlyStatus = (monthKey) => {
    const target = settings.monthlyTarget || 10000;
    const monthDeposits = transactions.filter(tx => tx.type === 'deposit' && tx.monthKey === monthKey);
    const p1Dep = monthDeposits.filter(t => t.partner === 'partner1');
    const p2Dep = monthDeposits.filter(t => t.partner === 'partner2');
    const p1Total = p1Dep.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const p2Total = p2Dep.reduce((sum, t) => sum + Number(t.amount || 0), 0);

    return {
      monthKey,
      targetPerPartner: target,
      partner1: {
        total: p1Total,
        isCompleted: p1Total >= target,
        remaining: Math.max(0, target - p1Total),
        lastDeposit: p1Dep.length > 0 ? p1Dep[p1Dep.length - 1] : null
      },
      partner2: {
        total: p2Total,
        isCompleted: p2Total >= target,
        remaining: Math.max(0, target - p2Total),
        lastDeposit: p2Dep.length > 0 ? p2Dep[p2Dep.length - 1] : null
      }
    };
  };

  const yearlyBreakdown = {};
  transactions.forEach(tx => {
    if (tx.type === 'deposit') {
      const yr = (tx.date || '').slice(0, 4) || new Date().getFullYear().toString();
      if (!yearlyBreakdown[yr]) {
        yearlyBreakdown[yr] = { year: yr, total: 0, partner1: 0, partner2: 0 };
      }
      const amt = Number(tx.amount) || 0;
      yearlyBreakdown[yr].total += amt;
      if (tx.partner === 'partner1') yearlyBreakdown[yr].partner1 += amt;
      else if (tx.partner === 'partner2') yearlyBreakdown[yr].partner2 += amt;
    }
  });

  return {
    currentBankBalance,
    totalDeposits,
    totalOutstandingLoans,
    partner1: {
      totalDeposited: partner1Deposits,
      activeLoanOwed: partner1LoanBalance,
      netSavings: partner1Deposits - partner1LoanBalance
    },
    partner2: {
      totalDeposited: partner2Deposits,
      activeLoanOwed: partner2LoanBalance,
      netSavings: partner2Deposits - partner2LoanBalance
    },
    currentMonthStatus: getMonthlyStatus(currentMonthKey),
    yearlyBreakdown
  };
}

// Global in-memory cache for fast reads / fallback
global._inMemoryAccounts = global._inMemoryAccounts || {};

// Read account data from Upstash Redis or memory
async function readAccountData(code) {
  if (!code || !/^\d{6}$/.test(code)) return null;

  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (kvUrl && kvToken) {
    try {
      const res = await fetch(`${kvUrl}/get/duosave_acc_${code}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      if (res.ok) {
        const json = await res.json();
        if (json && json.result !== undefined && json.result !== null) {
          let parsed = json.result;
          while (typeof parsed === 'string') {
            try {
              parsed = JSON.parse(parsed);
            } catch (e) {
              break;
            }
          }
          if (parsed && typeof parsed === 'object') {
            parsed.settings = Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {});
            parsed.transactions = Array.isArray(parsed.transactions) ? parsed.transactions : [];
            parsed.loans = Array.isArray(parsed.loans) ? parsed.loans : [];
            global._inMemoryAccounts[code] = parsed;
            return parsed;
          }
        }
      }
    } catch (err) {
      console.error("KV read error:", err);
    }
  }

  // Local filesystem fallback (if running locally or repository files)
  try {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, '..', 'data', 'accounts', `${code}.json`);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      let parsed = JSON.parse(raw);
      while (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (e) { break; }
      }
      if (parsed && typeof parsed === 'object') {
        parsed.settings = Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {});
        parsed.transactions = Array.isArray(parsed.transactions) ? parsed.transactions : [];
        parsed.loans = Array.isArray(parsed.loans) ? parsed.loans : [];
        return parsed;
      }
    }
  } catch (err) {
    // Ignore local read errors on serverless
  }

  const mem = global._inMemoryAccounts[code];
  if (mem && typeof mem === 'object') {
    mem.settings = Object.assign({}, DEFAULT_SETTINGS, mem.settings || {});
    mem.transactions = Array.isArray(mem.transactions) ? mem.transactions : [];
    mem.loans = Array.isArray(mem.loans) ? mem.loans : [];
    return mem;
  }

  return null;
}

// Save account data to Upstash Redis and memory
async function saveAccountData(code, data) {
  if (!code || !/^\d{6}$/.test(code)) return false;

  data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  data.transactions = Array.isArray(data.transactions) ? data.transactions : [];
  data.loans = Array.isArray(data.loans) ? data.loans : [];

  global._inMemoryAccounts[code] = data;

  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (kvUrl && kvToken) {
    try {
      const payload = JSON.stringify(data);
      await fetch(`${kvUrl}/set/duosave_acc_${code}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kvToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.error("KV write error:", err);
    }
  }

  // Local file fallback
  try {
    const fs = require('fs');
    const path = require('path');
    const accDir = path.join(__dirname, '..', 'data', 'accounts');
    if (!fs.existsSync(accDir)) fs.mkdirSync(accDir, { recursive: true });
    fs.writeFileSync(path.join(accDir, `${code}.json`), JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    // Ignore local write errors on serverless
  }

  return true;
}

// Safely parse request body across environments
async function getRequestBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return {};
  }
  if (req.readableEnded || req.complete) {
    return {};
  }
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve({}), 1000);
    req.on('data', chunk => { data += chunk.toString(); });
    req.on('end', () => {
      clearTimeout(timer);
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
  });
}

// Universal JSON response sender (no dependency on Express/Vercel helper methods)
function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

// Main Vercel serverless function export
module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-account-code, Cache-Control, Pragma, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = parsedUrl.pathname;
  if (pathname.endsWith('/') && pathname.length > 1) {
    pathname = pathname.slice(0, -1);
  }

  let body = {};
  try {
    body = await getRequestBody(req);
  } catch (e) {
    body = {};
  }

  const code = String(req.headers['x-account-code'] || parsedUrl.searchParams.get('code') || body.code || '').trim();

  try {
    // 1. CREATE ACCOUNT: POST /api/account/create
    if (req.method === 'POST' && pathname === '/api/account/create') {
      let targetCode = String(body.code || '').trim();

      // Auto-generate 6 digits if not provided
      if (!targetCode) {
        targetCode = String(Math.floor(100000 + Math.random() * 900000));
      }

      if (!/^\d{6}$/.test(targetCode)) {
        return sendJson(res, 400, { success: false, error: "Account code must be exactly 6 digits." });
      }

      const existing = await readAccountData(targetCode);
      if (existing) {
        return sendJson(res, 400, { success: false, error: `Account with code ${targetCode} already exists. Please pick another code or log in.` });
      }

      const p1 = (body.partner1Name && typeof body.partner1Name === 'string') ? body.partner1Name.trim() : "Partner 1";
      const p2 = (body.partner2Name && typeof body.partner2Name === 'string') ? body.partner2Name.trim() : "Partner 2";
      const accName = (body.accountName && typeof body.accountName === 'string') ? body.accountName.trim() : "Joint Savings Account";
      const curr = (body.currency && typeof body.currency === 'string') ? body.currency.trim() : "RWF";

      const newAccount = {
        code: targetCode,
        createdAt: new Date().toISOString(),
        settings: {
          partner1Name: p1 || "Partner 1",
          partner2Name: p2 || "Partner 2",
          monthlyTarget: Number(body.monthlyTarget) || 10000,
          currency: curr || "RWF",
          accountName: accName || "Joint Savings Account"
        },
        transactions: [],
        loans: []
      };

      await saveAccountData(targetCode, newAccount);

      return sendJson(res, 201, {
        success: true,
        code: targetCode,
        settings: newAccount.settings,
        summary: computeSummary(newAccount)
      });
    }

    // 2. LOGIN / VERIFY ACCOUNT: POST /api/account/login
    if (req.method === 'POST' && pathname === '/api/account/login') {
      const loginCode = String(body.code || code || '').trim();
      if (!loginCode || !/^\d{6}$/.test(loginCode)) {
        return sendJson(res, 400, { success: false, error: "Please enter your valid 6-digit account code." });
      }

      const account = await readAccountData(loginCode);
      if (!account) {
        return sendJson(res, 404, { success: false, error: `Account code "${loginCode}" was not found. Please check with your partner or create a new account.` });
      }

      return sendJson(res, 200, {
        success: true,
        code: loginCode,
        settings: account.settings || DEFAULT_SETTINGS,
        summary: computeSummary(account)
      });
    }

    // For all other routes, require a valid 6-digit code
    if (!code || !/^\d{6}$/.test(code)) {
      return sendJson(res, 401, { success: false, error: "Unauthorized: Please log in with your 6-digit account code." });
    }

    const db = await readAccountData(code);
    if (!db) {
      return sendJson(res, 404, { success: false, error: `Account code "${code}" not found. Please log in again.` });
    }

    // Ensure structures
    db.settings = db.settings || DEFAULT_SETTINGS;
    db.transactions = db.transactions || [];
    db.loans = db.loans || [];

    // GET /api/data
    if (req.method === 'GET' && pathname === '/api/data') {
      const summary = computeSummary(db);
      return sendJson(res, 200, {
        success: true,
        code,
        settings: db.settings,
        summary,
        loans: db.loans,
        transactions: db.transactions.sort((a, b) => new Date(b.date) - new Date(a.date))
      });
    }

    // POST /api/deposit
    if (req.method === 'POST' && pathname === '/api/deposit') {
      if (isFutureDate(body.date)) {
        return sendJson(res, 400, { success: false, error: "Future dates are not allowed. You can only record deposits for today or past dates." });
      }

      const partner = body.partner === 'partner2' ? 'partner2' : 'partner1';
      const amount = Number(body.amount) || db.settings.monthlyTarget || 10000;
      const depositDate = body.date ? new Date(body.date).toISOString() : new Date().toISOString();
      const monthKey = body.monthKey || depositDate.slice(0, 7);
      const partnerName = partner === 'partner1' ? db.settings.partner1Name : db.settings.partner2Name;

      const newTx = {
        id: 'tx_' + uuid(),
        type: 'deposit',
        partner,
        amount,
        date: depositDate,
        monthKey,
        note: body.note || `Monthly deposit of ${amount.toLocaleString()} ${db.settings.currency} by ${partnerName}`
      };

      db.transactions.push(newTx);
      await saveAccountData(code, db);

      return sendJson(res, 201, { success: true, transaction: newTx, summary: computeSummary(db) });
    }

    // POST /api/historical-batch
    if (req.method === 'POST' && pathname === '/api/historical-batch') {
      const entries = Array.isArray(body.entries) ? body.entries : [];
      const added = [];

      for (const item of entries) {
        if (isFutureDate(item.date)) continue;
        const partner = item.partner === 'partner2' ? 'partner2' : 'partner1';
        const amount = Number(item.amount) || db.settings.monthlyTarget || 10000;
        const depositDate = item.date ? new Date(item.date).toISOString() : new Date().toISOString();
        const monthKey = item.monthKey || depositDate.slice(0, 7);
        const partnerName = partner === 'partner1' ? db.settings.partner1Name : db.settings.partner2Name;

        const newTx = {
          id: 'tx_' + uuid(),
          type: 'deposit',
          partner,
          amount,
          date: depositDate,
          monthKey,
          note: item.note || `Monthly deposit of ${amount.toLocaleString()} ${db.settings.currency} by ${partnerName}`
        };

        db.transactions.push(newTx);
        added.push(newTx);
      }

      await saveAccountData(code, db);
      return sendJson(res, 201, { success: true, count: added.length, summary: computeSummary(db) });
    }

    // POST /api/loan
    if (req.method === 'POST' && pathname === '/api/loan') {
      if (isFutureDate(body.date)) {
        return sendJson(res, 400, { success: false, error: "Future dates are not allowed for loans taken." });
      }

      const partner = body.partner === 'partner2' ? 'partner2' : 'partner1';
      const amount = Number(body.amount);
      if (!amount || amount <= 0) {
        return sendJson(res, 400, { success: false, error: "Invalid loan amount" });
      }

      const loanDate = body.date ? new Date(body.date).toISOString() : new Date().toISOString();
      const partnerName = partner === 'partner1' ? db.settings.partner1Name : db.settings.partner2Name;
      const loanId = 'loan_' + uuid();

      const loanObj = {
        id: loanId,
        partner,
        originalAmount: amount,
        remainingAmount: amount,
        date: loanDate,
        reason: body.reason || "Personal Loan",
        dueDate: body.dueDate || null,
        status: 'active',
        repayments: []
      };

      const newTx = {
        id: 'tx_' + uuid(),
        type: 'loan',
        loanId,
        partner,
        amount,
        date: loanDate,
        monthKey: loanDate.slice(0, 7),
        note: `Loan taken: ${amount.toLocaleString()} ${db.settings.currency} by ${partnerName} (${loanObj.reason})`
      };

      db.loans.push(loanObj);
      db.transactions.push(newTx);
      await saveAccountData(code, db);

      return sendJson(res, 201, { success: true, loan: loanObj, transaction: newTx, summary: computeSummary(db) });
    }

    // POST /api/loan/repay
    if (req.method === 'POST' && pathname === '/api/loan/repay') {
      if (isFutureDate(body.date)) {
        return sendJson(res, 400, { success: false, error: "Future dates are not allowed for repayments." });
      }

      const loanId = body.loanId;
      const amount = Number(body.amount);
      const repayDate = body.date ? new Date(body.date).toISOString() : new Date().toISOString();

      const loan = db.loans.find(l => l.id === loanId);
      if (!loan) {
        return sendJson(res, 404, { success: false, error: "Loan not found" });
      }

      if (!amount || amount <= 0) {
        return sendJson(res, 400, { success: false, error: "Invalid repayment amount" });
      }

      const actualRepay = Math.min(amount, loan.remainingAmount);
      loan.remainingAmount -= actualRepay;
      if (loan.remainingAmount <= 0) {
        loan.status = 'repaid';
        loan.remainingAmount = 0;
      }

      const repaymentRecord = {
        id: 'repay_' + uuid(),
        amount: actualRepay,
        date: repayDate,
        note: body.note || `Repayment on loan "${loan.reason}"`
      };

      loan.repayments = loan.repayments || [];
      loan.repayments.push(repaymentRecord);

      const partnerName = loan.partner === 'partner1' ? db.settings.partner1Name : db.settings.partner2Name;
      const newTx = {
        id: 'tx_' + uuid(),
        type: 'repayment',
        loanId: loan.id,
        partner: loan.partner,
        amount: actualRepay,
        date: repayDate,
        monthKey: repayDate.slice(0, 7),
        note: `Loan repayment of ${actualRepay.toLocaleString()} ${db.settings.currency} by ${partnerName} (${loan.reason})`
      };

      db.transactions.push(newTx);
      await saveAccountData(code, db);

      return sendJson(res, 200, { success: true, loan, transaction: newTx, summary: computeSummary(db) });
    }

    // DELETE /api/transaction/:id
    if (req.method === 'DELETE' && pathname.startsWith('/api/transaction/')) {
      const txId = pathname.replace('/api/transaction/', '');
      const index = db.transactions.findIndex(t => t.id === txId);
      if (index === -1) {
        return sendJson(res, 404, { success: false, error: "Transaction not found" });
      }

      const tx = db.transactions[index];
      if (tx.type === 'loan' && tx.loanId) {
        db.loans = db.loans.filter(l => l.id !== tx.loanId);
      }
      db.transactions.splice(index, 1);
      await saveAccountData(code, db);

      return sendJson(res, 200, { success: true, summary: computeSummary(db) });
    }

    // PUT /api/settings
    if (req.method === 'PUT' && pathname === '/api/settings') {
      const p1 = (body.partner1Name && typeof body.partner1Name === 'string') ? body.partner1Name.trim() : db.settings.partner1Name;
      const p2 = (body.partner2Name && typeof body.partner2Name === 'string') ? body.partner2Name.trim() : db.settings.partner2Name;
      const accName = (body.accountName && typeof body.accountName === 'string') ? body.accountName.trim() : db.settings.accountName;
      const curr = (body.currency && typeof body.currency === 'string') ? body.currency.trim() : db.settings.currency;

      db.settings = {
        ...db.settings,
        partner1Name: p1 || db.settings.partner1Name,
        partner2Name: p2 || db.settings.partner2Name,
        monthlyTarget: Number(body.monthlyTarget) || db.settings.monthlyTarget || 10000,
        currency: curr || db.settings.currency || "RWF",
        accountName: accName || db.settings.accountName || "Joint Savings Account"
      };

      await saveAccountData(code, db);
      return sendJson(res, 200, { success: true, settings: db.settings, summary: computeSummary(db) });
    }

    return sendJson(res, 404, { error: "Route not found" });
  } catch (err) {
    console.error("Vercel Serverless Function Error:", err);
    return sendJson(res, 500, { error: err.message || "Internal server error" });
  }
};
