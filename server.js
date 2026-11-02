const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'database.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
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
  transactions: [
    {
      id: "seed_1",
      type: "deposit",
      partner: "partner1",
      amount: 10000,
      date: new Date(Date.now() - 3600000 * 2).toISOString(),
      monthKey: new Date().toISOString().slice(0, 7),
      note: "Monthly deposit for " + new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date())
    }
  ],
  loans: []
};

// Helper to read DB
function readDatabase() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf-8');
      return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error reading database:", err);
    return DEFAULT_DATA;
  }
}

// Helper to save DB
function saveDatabase(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error("Error writing database:", err);
    return false;
  }
}

// Check if date is in the future (with 1 minute tolerance)
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
  
  // Current bank balance: Deposits + Repayments - Loans Taken
  const currentBankBalance = (totalDeposits + totalLoansRepaid) - totalLoansTaken;

  const partner1LoanBalance = Math.max(0, partner1LoansTaken - partner1LoansRepaid);
  const partner2LoanBalance = Math.max(0, partner2LoansTaken - partner2LoansRepaid);
  const totalOutstandingLoans = partner1LoanBalance + partner2LoanBalance;

  // Monthly deposit status for current month and any requested month
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

  // Compute yearly breakdown
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
      if (body.length > 5 * 1024 * 1024) { // 5MB guard
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

// MIME types
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
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // API Endpoints
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');

    try {
      const db = readDatabase();

      // GET /api/data
      if (req.method === 'GET' && pathname === '/api/data') {
        const month = parsedUrl.searchParams.get('month') || new Date().toISOString().slice(0, 7);
        const summary = computeSummary(db);
        
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          settings: db.settings,
          summary,
          loans: db.loans || [],
          transactions: (db.transactions || []).sort((a, b) => new Date(b.date) - new Date(a.date))
        }));
        return;
      }

      // POST /api/deposit
      if (req.method === 'POST' && pathname === '/api/deposit') {
        const body = await parseJsonBody(req);
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
        saveDatabase(db);

        res.writeHead(201);
        res.end(JSON.stringify({ success: true, transaction: newTx, summary: computeSummary(db) }));
        return;
      }

      // POST /api/historical-batch (Bulk entry for past months / years)
      if (req.method === 'POST' && pathname === '/api/historical-batch') {
        const body = await parseJsonBody(req);
        const entries = Array.isArray(body.entries) ? body.entries : [];
        const addedTransactions = [];

        for (const item of entries) {
          if (isFutureDate(item.date)) continue; // ignore future dates
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
          addedTransactions.push(newTx);
        }

        saveDatabase(db);
        res.writeHead(201);
        res.end(JSON.stringify({ success: true, count: addedTransactions.length, summary: computeSummary(db) }));
        return;
      }

      // POST /api/loan
      if (req.method === 'POST' && pathname === '/api/loan') {
        const body = await parseJsonBody(req);
        if (isFutureDate(body.date)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: "Future dates are not allowed. You can only record loans for today or past dates." }));
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
          status: 'active', // 'active' | 'repaid'
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

        db.loans = db.loans || [];
        db.loans.push(loanObj);
        db.transactions.push(newTx);
        saveDatabase(db);

        res.writeHead(201);
        res.end(JSON.stringify({ success: true, loan: loanObj, transaction: newTx, summary: computeSummary(db) }));
        return;
      }

      // POST /api/loan/repay
      if (req.method === 'POST' && pathname === '/api/loan/repay') {
        const body = await parseJsonBody(req);
        if (isFutureDate(body.date)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: "Future dates are not allowed. You can only record repayments for today or past dates." }));
          return;
        }

        const loanId = body.loanId;
        const amount = Number(body.amount);
        const repayDate = body.date ? new Date(body.date).toISOString() : new Date().toISOString();

        db.loans = db.loans || [];
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
        saveDatabase(db);

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
        // If it was a loan, also remove or update the loan
        if (tx.type === 'loan' && tx.loanId) {
          db.loans = (db.loans || []).filter(l => l.id !== tx.loanId);
        }
        db.transactions.splice(index, 1);
        saveDatabase(db);

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, summary: computeSummary(db) }));
        return;
      }

      // PUT /api/settings
      if (req.method === 'PUT' && pathname === '/api/settings') {
        const body = await parseJsonBody(req);
        db.settings = {
          ...db.settings,
          partner1Name: body.partner1Name?.trim() || db.settings.partner1Name,
          partner2Name: body.partner2Name?.trim() || db.settings.partner2Name,
          monthlyTarget: Number(body.monthlyTarget) || db.settings.monthlyTarget || 10000,
          currency: body.currency?.trim() || db.settings.currency || "RWF",
          accountName: body.accountName?.trim() || db.settings.accountName || "Joint Savings Account"
        };
        saveDatabase(db);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, settings: db.settings, summary: computeSummary(db) }));
        return;
      }

      // POST /api/reset
      if (req.method === 'POST' && pathname === '/api/reset') {
        saveDatabase(DEFAULT_DATA);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: "Database reset to defaults" }));
        return;
      }

      // Unmatched API route
      res.writeHead(404);
      res.end(JSON.stringify({ error: "API Route not found" }));
      return;
    } catch (err) {
      console.error("API Error:", err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }

  // Static file server
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  let safePath = path.normalize(path.join(PUBLIC_DIR, reqPath));

  // Security check to avoid directory traversal
  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Access Denied');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA routing
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
  console.log(`🏦 Couple Shared Savings & Loan Tracker is running!`);
  console.log(`👉 Access URL: http://localhost:${PORT}`);
  console.log(`📅 Real-time clock and calendar active`);
  console.log(`💾 Database file: ${DATA_FILE}`);
  console.log(`=======================================================`);
});
