const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ensure data & accounts folders exist
if (!fs.existsSync(ACCOUNTS_DIR)) {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
}

// Initial default state
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

// Read account file
function readAccountFile(code) {
  if (!code || !/^\d{6}$/.test(code)) return null;
  const filePath = path.join(ACCOUNTS_DIR, `${code}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Error reading account ${code}:`, err);
    return null;
  }
}

// Save account file
function saveAccountFile(code, data) {
  if (!code || !/^\d{6}$/.test(code)) return false;
  const filePath = path.join(ACCOUNTS_DIR, `${code}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error(`Error saving account ${code}:`, err);
    return false;
  }
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

// Parse request body
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 5 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-account-code');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');

    try {
      const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await parseJsonBody(req) : {};
      const code = (req.headers['x-account-code'] || parsedUrl.searchParams.get('code') || body.code || '').trim();

      // 1. CREATE ACCOUNT: POST /api/account/create
      if (req.method === 'POST' && pathname === '/api/account/create') {
        let targetCode = (body.code || '').trim();
        if (!targetCode) {
          targetCode = String(Math.floor(100000 + Math.random() * 900000));
        }

        if (!/^\d{6}$/.test(targetCode)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: "Account code must be exactly 6 digits." }));
          return;
        }

        const existing = readAccountFile(targetCode);
        if (existing) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: `Account with code ${targetCode} already exists. Please pick another code or log in.` }));
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

        saveAccountFile(targetCode, newAccount);
        res.writeHead(201);
        res.end(JSON.stringify({
          success: true,
          code: targetCode,
          settings: newAccount.settings,
          summary: computeSummary(newAccount)
        }));
        return;
      }

      // 2. LOGIN / VERIFY ACCOUNT: POST /api/account/login
      if (req.method === 'POST' && pathname === '/api/account/login') {
        const loginCode = (body.code || code || '').trim();
        if (!loginCode || !/^\d{6}$/.test(loginCode)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: "Please enter a valid 6-digit login code." }));
          return;
        }

        const account = readAccountFile(loginCode);
        if (!account) {
          res.writeHead(404);
          res.end(JSON.stringify({ success: false, error: `Account code "${loginCode}" was not found. Please check with your partner or create a new account.` }));
          return;
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          code: loginCode,
          settings: account.settings,
          summary: computeSummary(account)
        }));
        return;
      }

      // For all other routes, require a valid 6-digit code
      if (!code || !/^\d{6}$/.test(code)) {
        res.writeHead(401);
        res.end(JSON.stringify({ success: false, error: "Unauthorized: Please log in with your 6-digit account code." }));
        return;
      }

      const db = readAccountFile(code);
      if (!db) {
        res.writeHead(404);
        res.end(JSON.stringify({ success: false, error: `Account code "${code}" not found. Please log in again.` }));
        return;
      }

      db.settings = db.settings || DEFAULT_DATA.settings;
      db.transactions = db.transactions || [];
      db.loans = db.loans || [];

      // GET /api/data
      if (req.method === 'GET' && pathname === '/api/data') {
        const summary = computeSummary(db);
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          code,
          settings: db.settings,
          summary,
          loans: db.loans,
          transactions: db.transactions.sort((a, b) => new Date(b.date) - new Date(a.date))
        }));
        return;
      }

      // POST /api/deposit
      if (req.method === 'POST' && pathname === '/api/deposit') {
        if (isFutureDate(body.date)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: "Future dates are not allowed. You can only record deposits for today or past dates." }));
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
        saveAccountFile(code, db);

        res.writeHead(201);
        res.end(JSON.stringify({ success: true, transaction: newTx, summary: computeSummary(db) }));
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

        saveAccountFile(code, db);
        res.writeHead(201);
        res.end(JSON.stringify({ success: true, count: added.length, summary: computeSummary(db) }));
        return;
      }

      // POST /api/loan
      if (req.method === 'POST' && pathname === '/api/loan') {
        if (isFutureDate(body.date)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: "Future dates are not allowed for loans taken." }));
          return;
        }

        const partner = body.partner === 'partner2' ? 'partner2' : 'partner1';
        const amount = Number(body.amount);
        if (!amount || amount <= 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: "Invalid loan amount" }));
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
        saveAccountFile(code, db);

        res.writeHead(201);
        res.end(JSON.stringify({ success: true, loan: loanObj, transaction: newTx, summary: computeSummary(db) }));
        return;
      }

      // POST /api/loan/repay
      if (req.method === 'POST' && pathname === '/api/loan/repay') {
        if (isFutureDate(body.date)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: "Future dates are not allowed for repayments." }));
          return;
        }

        const loanId = body.loanId;
        const amount = Number(body.amount);
        const repayDate = body.date ? new Date(body.date).toISOString() : new Date().toISOString();

        const loan = db.loans.find(l => l.id === loanId);
        if (!loan) {
          res.writeHead(404);
          res.end(JSON.stringify({ success: false, error: "Loan not found" }));
          return;
        }

        if (!amount || amount <= 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: "Invalid repayment amount" }));
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
        saveAccountFile(code, db);

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, loan, transaction: newTx, summary: computeSummary(db) }));
        return;
      }

      // DELETE /api/transaction/:id
      if (req.method === 'DELETE' && pathname.startsWith('/api/transaction/')) {
        const txId = pathname.replace('/api/transaction/', '');
        const index = db.transactions.findIndex(t => t.id === txId);
        if (index === -1) {
          res.writeHead(404);
          res.end(JSON.stringify({ success: false, error: "Transaction not found" }));
          return;
        }

        const tx = db.transactions[index];
        if (tx.type === 'loan' && tx.loanId) {
          db.loans = db.loans.filter(l => l.id !== tx.loanId);
        }
        db.transactions.splice(index, 1);
        saveAccountFile(code, db);

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, summary: computeSummary(db) }));
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
        saveAccountFile(code, db);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, settings: db.settings, summary: computeSummary(db) }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "Route not found" }));
    } catch (err) {
      console.error("API Error:", err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Static file server
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  let safePath = path.normalize(path.join(PUBLIC_DIR, reqPath));

  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Access Denied');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(indexPath).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(safePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🏦 DuoSave Multi-Account Server Running!`);
  console.log(`👉 Access URL: http://localhost:${PORT}`);
  console.log(`🔑 6-Digit Account Code Authentication Enabled`);
  console.log(`=======================================================`);
});
