const crypto = require('node:crypto');

const DEFAULT_DATA = {
  settings: {
    partner1Name: "Partner 1",
    partner2Name: "Partner 2",
    monthlyTarget: 10000,
    currency: "RWF",
    accountName: "Joint Savings Account"
  },
  transactions: [],
  loans: []
};

// Check if date is in the future
function isFutureDate(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr).getTime();
  const now = Date.now() + 60000;
  return d > now;
}

// Compute statistics and summary
function computeSummary(data) {
  let partner1Deposits = 0;
  let partner2Deposits = 0;
  let totalDeposits = 0;
  let partner1LoansTaken = 0;
  let partner2LoansTaken = 0;
  let partner1LoansRepaid = 0;
  let partner2LoansRepaid = 0;

  (data.transactions || []).forEach(tx => {
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
    const target = data.settings.monthlyTarget || 10000;
    const monthDeposits = (data.transactions || []).filter(tx => tx.type === 'deposit' && tx.monthKey === monthKey);
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
  (data.transactions || []).forEach(tx => {
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

// In-memory accounts storage fallback
global._inMemoryAccounts = global._inMemoryAccounts || {};

// Read account database from Vercel KV / Upstash or memory by 6-digit code
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
        if (json && json.result) {
          const parsed = typeof json.result === 'string' ? JSON.parse(json.result) : json.result;
          return parsed;
        }
      }
    } catch (err) {
      console.error("KV read error:", err);
    }
  }

  return global._inMemoryAccounts[code] || null;
}

// Save account database to Vercel KV / Upstash or memory by 6-digit code
async function saveAccountData(code, data) {
  if (!code || !/^\d{6}$/.test(code)) return false;

  global._inMemoryAccounts[code] = data;

  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (kvUrl && kvToken) {
    try {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      await fetch(kvUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kvToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(["SET", `duosave_acc_${code}`, payload])
      });
      return true;
    } catch (err) {
      console.error("KV write error:", err);
    }
  }
  return true;
}

// Helper to safely parse incoming JSON body from any runtime
async function parseRequestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk.toString(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// Vercel Serverless Function Handler
module.exports = async (req, res) => {
  // Polyfill res.status and res.json if running on raw Node http server
  if (typeof res.status !== 'function') {
    res.status = function(code) {
      this.statusCode = code;
      return this;
    };
  }
  if (typeof res.json !== 'function') {
    res.json = function(payload) {
      this.setHeader('Content-Type', 'application/json');
      this.end(JSON.stringify(payload));
    };
  }

  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-account-code');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = parsedUrl.pathname;
  if (pathname.endsWith('/') && pathname.length > 1) {
    pathname = pathname.slice(0, -1);
  }

  const body = await parseRequestBody(req);
  const code = String(req.headers['x-account-code'] || parsedUrl.searchParams.get('code') || body.code || '').trim();

  try {
    // 1. CREATE ACCOUNT: POST /api/account/create
    if (req.method === 'POST' && pathname === '/api/account/create') {
      let targetCode = (body.code || '').trim();
      
      // Auto-generate 6 digits if not provided
      if (!targetCode) {
        targetCode = String(Math.floor(100000 + Math.random() * 900000));
      }

      if (!/^\d{6}$/.test(targetCode)) {
        res.status(400).json({ success: false, error: "Account code must be exactly 6 digits." });
        return;
      }

      const existing = await readAccountData(targetCode);
      if (existing) {
        res.status(400).json({ success: false, error: `Account with code ${targetCode} already exists. Please pick another code or log in.` });
        return;
      }

      const newAccount = {
        code: targetCode,
        createdAt: new Date().toISOString(),
        settings: {
          partner1Name: body.partner1Name?.trim() || "Partner 1",
          partner2Name: body.partner2Name?.trim() || "Partner 2",
          monthlyTarget: Number(body.monthlyTarget) || 10000,
          currency: body.currency?.trim() || "RWF",
          accountName: body.accountName?.trim() || "Joint Savings Account"
        },
        transactions: [],
        loans: []
      };

      await saveAccountData(targetCode, newAccount);
      res.status(201).json({
        success: true,
        code: targetCode,
        settings: newAccount.settings,
        summary: computeSummary(newAccount)
      });
      return;
    }

    // 2. LOGIN / VERIFY ACCOUNT: POST /api/account/login
    if (req.method === 'POST' && pathname === '/api/account/login') {
      const loginCode = (body.code || code || '').trim();
      if (!loginCode || !/^\d{6}$/.test(loginCode)) {
        res.status(400).json({ success: false, error: "Please enter a valid 6-digit login code." });
        return;
      }

      const account = await readAccountData(loginCode);
      if (!account) {
        res.status(404).json({ success: false, error: `Account code "${loginCode}" was not found. Please check with your partner or create a new account.` });
        return;
      }

      res.status(200).json({
        success: true,
        code: loginCode,
        settings: account.settings,
        summary: computeSummary(account)
      });
      return;
    }

    // For all other routes, require a valid 6-digit code
    if (!code || !/^\d{6}$/.test(code)) {
      res.status(401).json({ success: false, error: "Unauthorized: Please log in with your 6-digit account code." });
      return;
    }

    const db = await readAccountData(code);
    if (!db) {
      res.status(404).json({ success: false, error: `Account code "${code}" not found. Please log in again.` });
      return;
    }

    // Ensure structures
    db.settings = db.settings || DEFAULT_DATA.settings;
    db.transactions = db.transactions || [];
    db.loans = db.loans || [];

    // GET /api/data
    if (req.method === 'GET' && pathname === '/api/data') {
      const summary = computeSummary(db);
      res.status(200).json({
        success: true,
        code,
        settings: db.settings,
        summary,
        loans: db.loans,
        transactions: db.transactions.sort((a, b) => new Date(b.date) - new Date(a.date))
      });
      return;
    }

    // POST /api/deposit
    if (req.method === 'POST' && pathname === '/api/deposit') {
      if (isFutureDate(body.date)) {
        res.status(400).json({ success: false, error: "Future dates are not allowed. You can only record deposits for today or past dates." });
        return;
      }

      const partner = body.partner === 'partner2' ? 'partner2' : 'partner1';
      const amount = Number(body.amount) || db.settings.monthlyTarget || 10000;
      const depositDate = body.date ? new Date(body.date).toISOString() : new Date().toISOString();
      const monthKey = body.monthKey || depositDate.slice(0, 7);
      const partnerName = partner === 'partner1' ? db.settings.partner1Name : db.settings.partner2Name;

      const newTx = {
        id: 'tx_' + crypto.randomUUID(),
        type: 'deposit',
        partner,
        amount,
        date: depositDate,
        monthKey,
        note: body.note || `Monthly deposit of ${amount.toLocaleString()} ${db.settings.currency} by ${partnerName}`
      };

      db.transactions.push(newTx);
      await saveAccountData(code, db);

      res.status(201).json({ success: true, transaction: newTx, summary: computeSummary(db) });
      return;
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
          id: 'tx_' + crypto.randomUUID(),
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
      res.status(201).json({ success: true, count: added.length, summary: computeSummary(db) });
      return;
    }

    // POST /api/loan
    if (req.method === 'POST' && pathname === '/api/loan') {
      if (isFutureDate(body.date)) {
        res.status(400).json({ success: false, error: "Future dates are not allowed for loans taken." });
        return;
      }

      const partner = body.partner === 'partner2' ? 'partner2' : 'partner1';
      const amount = Number(body.amount);
      if (!amount || amount <= 0) {
        res.status(400).json({ success: false, error: "Invalid loan amount" });
        return;
      }

      const loanDate = body.date ? new Date(body.date).toISOString() : new Date().toISOString();
      const partnerName = partner === 'partner1' ? db.settings.partner1Name : db.settings.partner2Name;
      const loanId = 'loan_' + crypto.randomUUID();

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
        id: 'tx_' + crypto.randomUUID(),
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

      res.status(201).json({ success: true, loan: loanObj, transaction: newTx, summary: computeSummary(db) });
      return;
    }

    // POST /api/loan/repay
    if (req.method === 'POST' && pathname === '/api/loan/repay') {
      if (isFutureDate(body.date)) {
        res.status(400).json({ success: false, error: "Future dates are not allowed for repayments." });
        return;
      }

      const loanId = body.loanId;
      const amount = Number(body.amount);
      const repayDate = body.date ? new Date(body.date).toISOString() : new Date().toISOString();

      const loan = db.loans.find(l => l.id === loanId);
      if (!loan) {
        res.status(404).json({ success: false, error: "Loan not found" });
        return;
      }

      if (!amount || amount <= 0) {
        res.status(400).json({ success: false, error: "Invalid repayment amount" });
        return;
      }

      const actualRepay = Math.min(amount, loan.remainingAmount);
      loan.remainingAmount -= actualRepay;
      if (loan.remainingAmount <= 0) {
        loan.status = 'repaid';
        loan.remainingAmount = 0;
      }

      const repaymentRecord = {
        id: 'repay_' + crypto.randomUUID(),
        amount: actualRepay,
        date: repayDate,
        note: body.note || `Repayment on loan "${loan.reason}"`
      };

      loan.repayments = loan.repayments || [];
      loan.repayments.push(repaymentRecord);

      const partnerName = loan.partner === 'partner1' ? db.settings.partner1Name : db.settings.partner2Name;
      const newTx = {
        id: 'tx_' + crypto.randomUUID(),
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

      res.status(200).json({ success: true, loan, transaction: newTx, summary: computeSummary(db) });
      return;
    }

    // DELETE /api/transaction/:id
    if (req.method === 'DELETE' && pathname.startsWith('/api/transaction/')) {
      const txId = pathname.replace('/api/transaction/', '');
      const index = db.transactions.findIndex(t => t.id === txId);
      if (index === -1) {
        res.status(404).json({ success: false, error: "Transaction not found" });
        return;
      }

      const tx = db.transactions[index];
      if (tx.type === 'loan' && tx.loanId) {
        db.loans = db.loans.filter(l => l.id !== tx.loanId);
      }
      db.transactions.splice(index, 1);
      await saveAccountData(code, db);

      res.status(200).json({ success: true, summary: computeSummary(db) });
      return;
    }

    // PUT /api/settings
    if (req.method === 'PUT' && pathname === '/api/settings') {
      db.settings = {
        ...db.settings,
        partner1Name: body.partner1Name?.trim() || db.settings.partner1Name,
        partner2Name: body.partner2Name?.trim() || db.settings.partner2Name,
        monthlyTarget: Number(body.monthlyTarget) || db.settings.monthlyTarget || 10000,
        currency: body.currency?.trim() || db.settings.currency || "RWF",
        accountName: body.accountName?.trim() || db.settings.accountName || "Joint Savings Account"
      };
      await saveAccountData(code, db);
      res.status(200).json({ success: true, settings: db.settings, summary: computeSummary(db) });
      return;
    }

    res.status(404).json({ error: "Route not found" });
  } catch (err) {
    console.error("Vercel Function Error:", err);
    res.status(500).json({ error: err.message });
  }
};
