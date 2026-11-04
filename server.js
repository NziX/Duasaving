const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ensure data & accounts folders exist for local file storage
try {
  if (!fs.existsSync(ACCOUNTS_DIR)) {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  }
} catch (e) {
  // Read-only filesystem in serverless environments
}

const DEFAULT_SETTINGS = {
  partner1Name: "Partner 1",
  partner2Name: "Partner 2",
  partner1Email: "",
  partner2Email: "",
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

// Global in-memory cache
global._inMemoryAccounts = global._inMemoryAccounts || {};
global._inMemoryEmailMap = global._inMemoryEmailMap || {};

const EMAIL_MAP_FILE = path.join(DATA_DIR, 'email-map.json');

// --- Email-to-code mapping helpers ---

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function isEmail(str) {
  return typeof str === 'string' && str.includes('@');
}

// Read the local email-map.json file
function readLocalEmailMap() {
  try {
    if (fs.existsSync(EMAIL_MAP_FILE)) {
      return JSON.parse(fs.readFileSync(EMAIL_MAP_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

// Write the local email-map.json file
function writeLocalEmailMap(map) {
  try {
    fs.writeFileSync(EMAIL_MAP_FILE, JSON.stringify(map, null, 2), 'utf-8');
  } catch (e) { /* ignore on read-only fs */ }
}

// Read email→code mapping (Redis → local file → memory)
async function readEmailMapping(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (kvUrl && kvToken) {
    try {
      const res = await fetch(`${kvUrl}/get/duosave_email_${normalized}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      if (res.ok) {
        const json = await res.json();
        if (json && json.result !== undefined && json.result !== null) {
          let code = json.result;
          while (typeof code === 'string') {
            try { const p = JSON.parse(code); code = p; } catch (e) { break; }
          }
          if (typeof code === 'string' && /^\d{6}$/.test(code)) {
            global._inMemoryEmailMap[normalized] = code;
            return code;
          }
        }
      }
    } catch (err) {
      console.error("Upstash email mapping read error:", err);
    }
  }

  // Local file fallback
  const localMap = readLocalEmailMap();
  if (localMap[normalized]) {
    global._inMemoryEmailMap[normalized] = localMap[normalized];
    return localMap[normalized];
  }

  // Filesystem accounts directory scan fallback
  try {
    if (fs.existsSync(ACCOUNTS_DIR)) {
      const files = fs.readdirSync(ACCOUNTS_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const accCode = file.replace('.json', '');
          const raw = fs.readFileSync(path.join(ACCOUNTS_DIR, file), 'utf-8');
          const acc = JSON.parse(raw);
          const accEmails = Array.isArray(acc.emails) ? acc.emails.map(normalizeEmail) : [];
          if (acc.settings) {
            if (acc.settings.partner1Email) accEmails.push(normalizeEmail(acc.settings.partner1Email));
            if (acc.settings.partner2Email) accEmails.push(normalizeEmail(acc.settings.partner2Email));
          }
          if (accEmails.includes(normalized)) {
            await saveEmailMapping(normalized, accCode);
            return accCode;
          }
        }
      }
    }
  } catch (err) {
    // ignore
  }

  // Memory fallback
  return global._inMemoryEmailMap[normalized] || null;
}

// Save email→code mapping (Redis + local file + memory)
async function saveEmailMapping(email, code) {
  const normalized = normalizeEmail(email);
  if (!normalized || !code) return;

  global._inMemoryEmailMap[normalized] = code;

  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (kvUrl && kvToken) {
    try {
      await fetch(`${kvUrl}/set/duosave_email_${normalized}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kvToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(code)
      });
    } catch (err) {
      console.error("Upstash email mapping write error:", err);
    }
  }

  // Local file
  const localMap = readLocalEmailMap();
  localMap[normalized] = code;
  writeLocalEmailMap(localMap);
}

// Remove email→code mapping (Redis + local file + memory)
async function removeEmailMapping(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return;

  delete global._inMemoryEmailMap[normalized];

  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (kvUrl && kvToken) {
    try {
      await fetch(`${kvUrl}/del/duosave_email_${normalized}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}` }
      });
    } catch (err) {
      console.error("Upstash email mapping delete error:", err);
    }
  }

  // Local file
  const localMap = readLocalEmailMap();
  delete localMap[normalized];
  writeLocalEmailMap(localMap);
}

// Collect and deduplicate emails from body fields
function collectEmails(body) {
  const emails = [];
  if (body.partner1Email && typeof body.partner1Email === 'string') {
    const e = normalizeEmail(body.partner1Email);
    if (e && isEmail(e)) emails.push(e);
  }
  if (body.partner2Email && typeof body.partner2Email === 'string') {
    const e = normalizeEmail(body.partner2Email);
    if (e && isEmail(e) && !emails.includes(e)) emails.push(e);
  }
  return emails;
}

// Read account data (Upstash Redis -> Local Filesystem -> Memory)
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
          // Unwind any JSON stringification layers safely
          while (typeof parsed === 'string') {
            try {
              parsed = JSON.parse(parsed);
            } catch (e) {
              break;
            }
          }
          if (parsed && typeof parsed === 'object') {
            parsed.settings = Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {});
            parsed.emails = Array.isArray(parsed.emails) ? parsed.emails : [];
            parsed.transactions = Array.isArray(parsed.transactions) ? parsed.transactions : [];
            parsed.loans = Array.isArray(parsed.loans) ? parsed.loans : [];
            global._inMemoryAccounts[code] = parsed;
            return parsed;
          }
        }
      }
    } catch (err) {
      console.error("Upstash read error:", err);
    }
  }

  // Local file fallback
  try {
    const filePath = path.join(ACCOUNTS_DIR, `${code}.json`);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        parsed.settings = Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {});
        parsed.emails = Array.isArray(parsed.emails) ? parsed.emails : [];
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
    mem.emails = Array.isArray(mem.emails) ? mem.emails : [];
    mem.transactions = Array.isArray(mem.transactions) ? mem.transactions : [];
    mem.loans = Array.isArray(mem.loans) ? mem.loans : [];
    return mem;
  }

  return null;
}

// Save account data (Upstash Redis + Local Filesystem + Memory)
async function saveAccountData(code, data) {
  if (!code || !/^\d{6}$/.test(code)) return false;

  data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  data.emails = Array.isArray(data.emails) ? data.emails : [];
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
      return true;
    } catch (err) {
      console.error("Upstash write error:", err);
    }
  }

  // Local file fallback
  try {
    const filePath = path.join(ACCOUNTS_DIR, `${code}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    // Ignore local write errors on serverless
  }

  return true;
}

// Compute statistics and summary
function computeSummary(data) {
  const settings = (data && data.settings) ? data.settings : DEFAULT_SETTINGS;
  const transactions = (data && Array.isArray(data.transactions)) ? data.transactions : [];
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

// Safely parse JSON body
function parseJsonBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
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
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
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
  // CORS
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

  // Handle API Routes
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');

    try {
      const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await parseJsonBody(req) : {};
      const code = String(req.headers['x-account-code'] || parsedUrl.searchParams.get('code') || body.code || '').trim();

      // 1. CREATE ACCOUNT: POST /api/account/create
      if (req.method === 'POST' && pathname === '/api/account/create') {
        let targetCode = String(body.code || '').trim();
        if (!targetCode) {
          targetCode = String(Math.floor(100000 + Math.random() * 900000));
        }

        if (!/^\d{6}$/.test(targetCode)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: "Account code must be exactly 6 digits." }));
          return;
        }

        const existing = await readAccountData(targetCode);
        if (existing) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: `Account with code ${targetCode} already exists. Please pick another code or log in.` }));
          return;
        }

        const p1 = (body.partner1Name && typeof body.partner1Name === 'string') ? body.partner1Name.trim() : "Partner 1";
        const p2 = (body.partner2Name && typeof body.partner2Name === 'string') ? body.partner2Name.trim() : "Partner 2";
        const accName = (body.accountName && typeof body.accountName === 'string') ? body.accountName.trim() : "Joint Savings Account";
        const curr = (body.currency && typeof body.currency === 'string') ? body.currency.trim() : "RWF";

        // Collect optional emails
        const emails = collectEmails(body);

        // Verify none of the emails are already claimed by an existing account
        for (const email of emails) {
          const mapped = await readEmailMapping(email);
          if (mapped) {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: `Email "${email}" is already linked to joint account code ${mapped}. Please log in instead.` }));
            return;
          }
        }

        const newAccount = {
          code: targetCode,
          createdAt: new Date().toISOString(),
          settings: {
            partner1Name: p1 || "Partner 1",
            partner2Name: p2 || "Partner 2",
            partner1Email: body.partner1Email ? normalizeEmail(body.partner1Email) : "",
            partner2Email: body.partner2Email ? normalizeEmail(body.partner2Email) : "",
            monthlyTarget: Number(body.monthlyTarget) || 10000,
            currency: curr || "RWF",
            accountName: accName || "Joint Savings Account"
          },
          emails: emails,
          transactions: [],
          loans: []
        };

        await saveAccountData(targetCode, newAccount);

        // Save email→code mappings
        for (const email of emails) {
          await saveEmailMapping(email, targetCode);
        }

        res.writeHead(201);
        res.end(JSON.stringify({
          success: true,
          code: targetCode,
          settings: newAccount.settings,
          emails: newAccount.emails,
          summary: computeSummary(newAccount)
        }));
        return;
      }

      // 2. LOGIN / VERIFY ACCOUNT: POST /api/account/login
      if (req.method === 'POST' && pathname === '/api/account/login') {
        const loginInput = String(body.code || body.email || body.loginInput || code || '').trim();
        if (!loginInput) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: "Please enter your 6-digit account code or email address." }));
          return;
        }

        let targetCode = null;
        if (/^\d{6}$/.test(loginInput)) {
          targetCode = loginInput;
        } else if (isEmail(loginInput)) {
          targetCode = await readEmailMapping(loginInput);
          if (!targetCode) {
            res.writeHead(404);
            res.end(JSON.stringify({
              success: false,
              error: `No joint account found linked to email "${loginInput}". Please verify your email or connect using your 6-digit code.`
            }));
            return;
          }
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: "Please enter a valid 6-digit code or email address." }));
          return;
        }

        const account = await readAccountData(targetCode);
        if (!account) {
          res.writeHead(404);
          res.end(JSON.stringify({ success: false, error: `Account code "${targetCode}" was not found. Please check with your partner or create a new account.` }));
          return;
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          code: targetCode,
          settings: account.settings || DEFAULT_SETTINGS,
          emails: account.emails || [],
          summary: computeSummary(account)
        }));
        return;
      }

      // All other routes require a valid 6-digit account code
      if (!code || !/^\d{6}$/.test(code)) {
        res.writeHead(401);
        res.end(JSON.stringify({ success: false, error: "Unauthorized: Please log in with your 6-digit account code." }));
        return;
      }

      const db = await readAccountData(code);
      if (!db) {
        res.writeHead(404);
        res.end(JSON.stringify({ success: false, error: `Account code "${code}" not found. Please log in again.` }));
        return;
      }

      db.settings = Object.assign({}, DEFAULT_SETTINGS, db.settings || {});
      db.transactions = Array.isArray(db.transactions) ? db.transactions : [];
      db.loans = Array.isArray(db.loans) ? db.loans : [];

      const p1Name = db.settings.partner1Name || "Partner 1";
      const p2Name = db.settings.partner2Name || "Partner 2";
      const currency = db.settings.currency || "RWF";

      // GET /api/data
      if (req.method === 'GET' && pathname === '/api/data') {
        const summary = computeSummary(db);
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          code,
          settings: db.settings,
          emails: db.emails || [],
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
        const partnerName = partner === 'partner1' ? p1Name : p2Name;

        const newTx = {
          id: 'tx_' + uuid(),
          type: 'deposit',
          partner,
          amount,
          date: depositDate,
          monthKey,
          note: body.note || `Monthly deposit of ${amount.toLocaleString()} ${currency} by ${partnerName}`
        };

        db.transactions.push(newTx);
        await saveAccountData(code, db);

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
          const partnerName = partner === 'partner1' ? p1Name : p2Name;

          const newTx = {
            id: 'tx_' + uuid(),
            type: 'deposit',
            partner,
            amount,
            date: depositDate,
            monthKey,
            note: item.note || `Monthly deposit of ${amount.toLocaleString()} ${currency} by ${partnerName}`
          };

          db.transactions.push(newTx);
          added.push(newTx);
        }

        await saveAccountData(code, db);
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
        const partnerName = partner === 'partner1' ? p1Name : p2Name;
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
          note: `Loan taken: ${amount.toLocaleString()} ${currency} by ${partnerName} (${loanObj.reason})`
        };

        db.loans.push(loanObj);
        db.transactions.push(newTx);
        await saveAccountData(code, db);

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
          id: 'repay_' + uuid(),
          amount: actualRepay,
          date: repayDate,
          note: body.note || `Repayment on loan "${loan.reason}"`
        };

        loan.repayments = loan.repayments || [];
        loan.repayments.push(repaymentRecord);

        const partnerName = loan.partner === 'partner1' ? p1Name : p2Name;
        const newTx = {
          id: 'tx_' + uuid(),
          type: 'repayment',
          loanId: loan.id,
          partner: loan.partner,
          amount: actualRepay,
          date: repayDate,
          monthKey: repayDate.slice(0, 7),
          note: `Loan repayment of ${actualRepay.toLocaleString()} ${currency} by ${partnerName} (${loan.reason})`
        };

        db.transactions.push(newTx);
        await saveAccountData(code, db);

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
        await saveAccountData(code, db);

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, summary: computeSummary(db) }));
        return;
      }

      // PUT /api/settings
      if (req.method === 'PUT' && pathname === '/api/settings') {
        const p1 = (body.partner1Name && typeof body.partner1Name === 'string') ? body.partner1Name.trim() : p1Name;
        const p2 = (body.partner2Name && typeof body.partner2Name === 'string') ? body.partner2Name.trim() : p2Name;
        const accName = (body.accountName && typeof body.accountName === 'string') ? body.accountName.trim() : (db.settings.accountName || "Joint Savings Account");
        const curr = (body.currency && typeof body.currency === 'string') ? body.currency.trim() : currency;

        // Partner emails
        const p1Email = body.partner1Email !== undefined ? normalizeEmail(body.partner1Email) : (db.settings.partner1Email || '');
        const p2Email = body.partner2Email !== undefined ? normalizeEmail(body.partner2Email) : (db.settings.partner2Email || '');

        // Verify newly supplied emails are not linked to another account
        for (const em of [p1Email, p2Email]) {
          if (em && isEmail(em)) {
            const existingCode = await readEmailMapping(em);
            if (existingCode && existingCode !== code) {
              res.writeHead(400);
              res.end(JSON.stringify({ success: false, error: `Email "${em}" is already linked to another joint account (${existingCode}).` }));
              return;
            }
          }
        }

        // Compute new email list
        const newEmails = [];
        if (p1Email && isEmail(p1Email)) newEmails.push(p1Email);
        if (p2Email && isEmail(p2Email) && !newEmails.includes(p2Email)) newEmails.push(p2Email);

        // Unlink old emails that are removed
        const oldEmails = Array.isArray(db.emails) ? db.emails : [];
        for (const oldEmail of oldEmails) {
          if (!newEmails.includes(oldEmail)) {
            await removeEmailMapping(oldEmail);
          }
        }

        // Link new emails
        for (const newEmail of newEmails) {
          await saveEmailMapping(newEmail, code);
        }

        db.emails = newEmails;
        db.settings = {
          ...db.settings,
          partner1Name: p1 || "Partner 1",
          partner2Name: p2 || "Partner 2",
          partner1Email: p1Email,
          partner2Email: p2Email,
          monthlyTarget: Number(body.monthlyTarget) || db.settings.monthlyTarget || 10000,
          currency: curr || "RWF",
          accountName: accName || "Joint Savings Account"
        };

        await saveAccountData(code, db);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, settings: db.settings, emails: db.emails, summary: computeSummary(db) }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "Route not found" }));
    } catch (err) {
      console.error("Server API Error:", err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message || "Internal server error" }));
    }
    return;
  }

  // Handle Static Files (Serve from public/ or root)
  let cleanPath = pathname === '/' ? '/index.html' : pathname;
  let filePath = path.join(PUBLIC_DIR, cleanPath);

  // If not in public, check root directory
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, cleanPath);
  }

  // Fallback to index.html for SPA
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(filePath)) {
      filePath = path.join(__dirname, 'index.html');
    }
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

module.exports = server;

// Start listening when executed directly or locally
if (require.main === module || !process.env.VERCEL) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`🏦 DuoSave Multi-Account Server Running!`);
    console.log(`👉 Access URL: http://localhost:${PORT}`);
    console.log(`🔑 6-Digit Account Code Authentication Enabled`);
    console.log(`=======================================================`);
  });
}
