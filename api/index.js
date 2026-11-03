var http = require('http');
var https = require('https');

function uuid() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

var DEFAULT_DATA = {
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
  var d = new Date(dateStr).getTime();
  var now = Date.now() + 60000;
  return d > now;
}

// HTTP helper for Upstash REST API calls
function kvRequest(method, urlStr, headers, body) {
  return new Promise(function(resolve, reject) {
    var parsed = new URL(urlStr);
    var mod = parsed.protocol === 'https:' ? https : http;
    var opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method,
      headers: headers
    };
    var req = mod.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var text = Buffer.concat(chunks).toString();
        try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: JSON.parse(text) }); }
        catch (e) { resolve({ ok: false, status: res.statusCode, json: null }); }
      });
    });
    req.on('error', function(err) { reject(err); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// Compute statistics and summary
function computeSummary(data) {
  var partner1Deposits = 0;
  var partner2Deposits = 0;
  var totalDeposits = 0;
  var partner1LoansTaken = 0;
  var partner2LoansTaken = 0;
  var partner1LoansRepaid = 0;
  var partner2LoansRepaid = 0;

  (data.transactions || []).forEach(function(tx) {
    var amt = Number(tx.amount) || 0;
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

  var totalLoansTaken = partner1LoansTaken + partner2LoansTaken;
  var totalLoansRepaid = partner1LoansRepaid + partner2LoansRepaid;
  var currentBankBalance = (totalDeposits + totalLoansRepaid) - totalLoansTaken;

  var partner1LoanBalance = Math.max(0, partner1LoansTaken - partner1LoansRepaid);
  var partner2LoanBalance = Math.max(0, partner2LoansTaken - partner2LoansRepaid);
  var totalOutstandingLoans = partner1LoanBalance + partner2LoanBalance;

  var currentMonthKey = new Date().toISOString().slice(0, 7);

  var getMonthlyStatus = function(monthKey) {
    var target = data.settings.monthlyTarget || 10000;
    var monthDeposits = (data.transactions || []).filter(function(tx) { return tx.type === 'deposit' && tx.monthKey === monthKey; });
    var p1Dep = monthDeposits.filter(function(t) { return t.partner === 'partner1'; });
    var p2Dep = monthDeposits.filter(function(t) { return t.partner === 'partner2'; });
    var p1Total = p1Dep.reduce(function(sum, t) { return sum + Number(t.amount || 0); }, 0);
    var p2Total = p2Dep.reduce(function(sum, t) { return sum + Number(t.amount || 0); }, 0);

    return {
      monthKey: monthKey,
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

  var yearlyBreakdown = {};
  (data.transactions || []).forEach(function(tx) {
    if (tx.type === 'deposit') {
      var yr = (tx.date || '').slice(0, 4) || new Date().getFullYear().toString();
      if (!yearlyBreakdown[yr]) {
        yearlyBreakdown[yr] = { year: yr, total: 0, partner1: 0, partner2: 0 };
      }
      var amt = Number(tx.amount) || 0;
      yearlyBreakdown[yr].total += amt;
      if (tx.partner === 'partner1') yearlyBreakdown[yr].partner1 += amt;
      else if (tx.partner === 'partner2') yearlyBreakdown[yr].partner2 += amt;
    }
  });

  return {
    currentBankBalance: currentBankBalance,
    totalDeposits: totalDeposits,
    totalOutstandingLoans: totalOutstandingLoans,
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
    yearlyBreakdown: yearlyBreakdown
  };
}

// Read account database from Upstash Redis by 6-digit code
function readAccountData(code) {
  if (!code || !/^\d{6}$/.test(code)) return Promise.resolve(null);

  var kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  var kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (kvUrl && kvToken) {
    return kvRequest('GET', kvUrl + '/get/duosave_acc_' + code, {
      Authorization: 'Bearer ' + kvToken
    }, null).then(function(res) {
      if (res.ok && res.json && res.json.result) {
        var parsed = typeof res.json.result === 'string' ? JSON.parse(res.json.result) : res.json.result;
        return parsed;
      }
      return null;
    }).catch(function(err) {
      console.error("KV read error:", err);
      return null;
    });
  }

  return Promise.resolve(null);
}

// Save account database to Upstash Redis by 6-digit code
function saveAccountData(code, data) {
  if (!code || !/^\d{6}$/.test(code)) return Promise.resolve(false);

  var kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  var kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (kvUrl && kvToken) {
    var payload = typeof data === 'string' ? data : JSON.stringify(data);
    return kvRequest('POST', kvUrl, {
      Authorization: 'Bearer ' + kvToken,
      'Content-Type': 'application/json'
    }, JSON.stringify(["SET", "duosave_acc_" + code, payload])).then(function() {
      return true;
    }).catch(function(err) {
      console.error("KV write error:", err);
      return true;
    });
  }
  return Promise.resolve(true);
}

// Helper to safely parse incoming JSON body
function parseRequestBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return Promise.resolve({});
  }
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  if (req.readableEnded || req.complete) {
    return Promise.resolve({});
  }
  return new Promise(function(resolve) {
    var data = '';
    var timer = setTimeout(function() { resolve({}); }, 800);
    req.on('data', function(chunk) { data += chunk.toString(); });
    req.on('end', function() {
      clearTimeout(timer);
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { resolve({}); }
    });
    req.on('error', function() {
      clearTimeout(timer);
      resolve({});
    });
  });
}

// Safe accessor helper
function safeStr(val) {
  return val && typeof val === 'string' ? val.trim() : '';
}

// Vercel Serverless Function Handler
module.exports = function(req, res) {
  // Polyfill res.status and res.json if needed
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

  var parsedUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  var pathname = parsedUrl.pathname;
  if (pathname.endsWith('/') && pathname.length > 1) {
    pathname = pathname.slice(0, -1);
  }

  return parseRequestBody(req).then(function(body) {
    var code = String(req.headers['x-account-code'] || parsedUrl.searchParams.get('code') || body.code || '').trim();

    // 1. CREATE ACCOUNT: POST /api/account/create
    if (req.method === 'POST' && pathname === '/api/account/create') {
      var targetCode = safeStr(body.code);

      // Auto-generate 6 digits if not provided
      if (!targetCode) {
        targetCode = String(Math.floor(100000 + Math.random() * 900000));
      }

      if (!/^\d{6}$/.test(targetCode)) {
        res.status(400).json({ success: false, error: "Account code must be exactly 6 digits." });
        return;
      }

      return readAccountData(targetCode).then(function(existing) {
        if (existing) {
          res.status(400).json({ success: false, error: "Account with code " + targetCode + " already exists. Please pick another code or log in." });
          return;
        }

        var newAccount = {
          code: targetCode,
          createdAt: new Date().toISOString(),
          settings: {
            partner1Name: safeStr(body.partner1Name) || "Partner 1",
            partner2Name: safeStr(body.partner2Name) || "Partner 2",
            monthlyTarget: Number(body.monthlyTarget) || 10000,
            currency: safeStr(body.currency) || "RWF",
            accountName: safeStr(body.accountName) || "Joint Savings Account"
          },
          transactions: [],
          loans: []
        };

        return saveAccountData(targetCode, newAccount).then(function() {
          res.status(201).json({
            success: true,
            code: targetCode,
            settings: newAccount.settings,
            summary: computeSummary(newAccount)
          });
        });
      });
    }

    // 2. LOGIN / VERIFY ACCOUNT: POST /api/account/login
    if (req.method === 'POST' && pathname === '/api/account/login') {
      var loginCode = safeStr(body.code) || code;
      if (!loginCode || !/^\d{6}$/.test(loginCode)) {
        res.status(400).json({ success: false, error: "Please enter a valid 6-digit login code." });
        return;
      }

      return readAccountData(loginCode).then(function(account) {
        if (!account) {
          res.status(404).json({ success: false, error: 'Account code "' + loginCode + '" was not found. Please check with your partner or create a new account.' });
          return;
        }

        res.status(200).json({
          success: true,
          code: loginCode,
          settings: account.settings,
          summary: computeSummary(account)
        });
      });
    }

    // For all other routes, require a valid 6-digit code
    if (!code || !/^\d{6}$/.test(code)) {
      res.status(401).json({ success: false, error: "Unauthorized: Please log in with your 6-digit account code." });
      return;
    }

    return readAccountData(code).then(function(db) {
      if (!db) {
        res.status(404).json({ success: false, error: 'Account code "' + code + '" not found. Please log in again.' });
        return;
      }

      // Ensure structures
      db.settings = db.settings || DEFAULT_DATA.settings;
      db.transactions = db.transactions || [];
      db.loans = db.loans || [];

      // GET /api/data
      if (req.method === 'GET' && pathname === '/api/data') {
        var summary = computeSummary(db);
        res.status(200).json({
          success: true,
          code: code,
          settings: db.settings,
          summary: summary,
          loans: db.loans,
          transactions: db.transactions.sort(function(a, b) { return new Date(b.date) - new Date(a.date); })
        });
        return;
      }

      // POST /api/deposit
      if (req.method === 'POST' && pathname === '/api/deposit') {
        if (isFutureDate(body.date)) {
          res.status(400).json({ success: false, error: "Future dates are not allowed. You can only record deposits for today or past dates." });
          return;
        }

        var partner = body.partner === 'partner2' ? 'partner2' : 'partner1';
        var amount = Number(body.amount) || db.settings.monthlyTarget || 10000;
        var depositDate = body.date ? new Date(body.date).toISOString() : new Date().toISOString();
        var monthKey = body.monthKey || depositDate.slice(0, 7);
        var partnerName = partner === 'partner1' ? db.settings.partner1Name : db.settings.partner2Name;

        var newTx = {
          id: 'tx_' + uuid(),
          type: 'deposit',
          partner: partner,
          amount: amount,
          date: depositDate,
          monthKey: monthKey,
          note: body.note || 'Monthly deposit of ' + amount.toLocaleString() + ' ' + db.settings.currency + ' by ' + partnerName
        };

        db.transactions.push(newTx);
        return saveAccountData(code, db).then(function() {
          res.status(201).json({ success: true, transaction: newTx, summary: computeSummary(db) });
        });
      }

      // POST /api/historical-batch
      if (req.method === 'POST' && pathname === '/api/historical-batch') {
        var entries = Array.isArray(body.entries) ? body.entries : [];
        var added = [];

        for (var i = 0; i < entries.length; i++) {
          var item = entries[i];
          if (isFutureDate(item.date)) continue;
          var bp = item.partner === 'partner2' ? 'partner2' : 'partner1';
          var ba = Number(item.amount) || db.settings.monthlyTarget || 10000;
          var bd = item.date ? new Date(item.date).toISOString() : new Date().toISOString();
          var bm = item.monthKey || bd.slice(0, 7);
          var bn = bp === 'partner1' ? db.settings.partner1Name : db.settings.partner2Name;

          var btx = {
            id: 'tx_' + uuid(),
            type: 'deposit',
            partner: bp,
            amount: ba,
            date: bd,
            monthKey: bm,
            note: item.note || 'Monthly deposit of ' + ba.toLocaleString() + ' ' + db.settings.currency + ' by ' + bn
          };

          db.transactions.push(btx);
          added.push(btx);
        }

        return saveAccountData(code, db).then(function() {
          res.status(201).json({ success: true, count: added.length, summary: computeSummary(db) });
        });
      }

      // POST /api/loan
      if (req.method === 'POST' && pathname === '/api/loan') {
        if (isFutureDate(body.date)) {
          res.status(400).json({ success: false, error: "Future dates are not allowed for loans taken." });
          return;
        }

        var lp = body.partner === 'partner2' ? 'partner2' : 'partner1';
        var la = Number(body.amount);
        if (!la || la <= 0) {
          res.status(400).json({ success: false, error: "Invalid loan amount" });
          return;
        }

        var ld = body.date ? new Date(body.date).toISOString() : new Date().toISOString();
        var ln = lp === 'partner1' ? db.settings.partner1Name : db.settings.partner2Name;
        var loanId = 'loan_' + uuid();

        var loanObj = {
          id: loanId,
          partner: lp,
          originalAmount: la,
          remainingAmount: la,
          date: ld,
          reason: body.reason || "Personal Loan",
          dueDate: body.dueDate || null,
          status: 'active',
          repayments: []
        };

        var ltx = {
          id: 'tx_' + uuid(),
          type: 'loan',
          loanId: loanId,
          partner: lp,
          amount: la,
          date: ld,
          monthKey: ld.slice(0, 7),
          note: 'Loan taken: ' + la.toLocaleString() + ' ' + db.settings.currency + ' by ' + ln + ' (' + loanObj.reason + ')'
        };

        db.loans.push(loanObj);
        db.transactions.push(ltx);
        return saveAccountData(code, db).then(function() {
          res.status(201).json({ success: true, loan: loanObj, transaction: ltx, summary: computeSummary(db) });
        });
      }

      // POST /api/loan/repay
      if (req.method === 'POST' && pathname === '/api/loan/repay') {
        if (isFutureDate(body.date)) {
          res.status(400).json({ success: false, error: "Future dates are not allowed for repayments." });
          return;
        }

        var rloanId = body.loanId;
        var ramount = Number(body.amount);
        var rdate = body.date ? new Date(body.date).toISOString() : new Date().toISOString();

        var loan = null;
        for (var li = 0; li < db.loans.length; li++) {
          if (db.loans[li].id === rloanId) { loan = db.loans[li]; break; }
        }
        if (!loan) {
          res.status(404).json({ success: false, error: "Loan not found" });
          return;
        }

        if (!ramount || ramount <= 0) {
          res.status(400).json({ success: false, error: "Invalid repayment amount" });
          return;
        }

        var actualRepay = Math.min(ramount, loan.remainingAmount);
        loan.remainingAmount -= actualRepay;
        if (loan.remainingAmount <= 0) {
          loan.status = 'repaid';
          loan.remainingAmount = 0;
        }

        var repaymentRecord = {
          id: 'repay_' + uuid(),
          amount: actualRepay,
          date: rdate,
          note: body.note || 'Repayment on loan "' + loan.reason + '"'
        };

        loan.repayments = loan.repayments || [];
        loan.repayments.push(repaymentRecord);

        var rpn = loan.partner === 'partner1' ? db.settings.partner1Name : db.settings.partner2Name;
        var rtx = {
          id: 'tx_' + uuid(),
          type: 'repayment',
          loanId: loan.id,
          partner: loan.partner,
          amount: actualRepay,
          date: rdate,
          monthKey: rdate.slice(0, 7),
          note: 'Loan repayment of ' + actualRepay.toLocaleString() + ' ' + db.settings.currency + ' by ' + rpn + ' (' + loan.reason + ')'
        };

        db.transactions.push(rtx);
        return saveAccountData(code, db).then(function() {
          res.status(200).json({ success: true, loan: loan, transaction: rtx, summary: computeSummary(db) });
        });
      }

      // DELETE /api/transaction/:id
      if (req.method === 'DELETE' && pathname.indexOf('/api/transaction/') === 0) {
        var txId = pathname.replace('/api/transaction/', '');
        var index = -1;
        for (var di = 0; di < db.transactions.length; di++) {
          if (db.transactions[di].id === txId) { index = di; break; }
        }
        if (index === -1) {
          res.status(404).json({ success: false, error: "Transaction not found" });
          return;
        }

        var dtx = db.transactions[index];
        if (dtx.type === 'loan' && dtx.loanId) {
          db.loans = db.loans.filter(function(l) { return l.id !== dtx.loanId; });
        }
        db.transactions.splice(index, 1);
        return saveAccountData(code, db).then(function() {
          res.status(200).json({ success: true, summary: computeSummary(db) });
        });
      }

      // PUT /api/settings
      if (req.method === 'PUT' && pathname === '/api/settings') {
        db.settings = {
          partner1Name: safeStr(body.partner1Name) || db.settings.partner1Name,
          partner2Name: safeStr(body.partner2Name) || db.settings.partner2Name,
          monthlyTarget: Number(body.monthlyTarget) || db.settings.monthlyTarget || 10000,
          currency: safeStr(body.currency) || db.settings.currency || "RWF",
          accountName: safeStr(body.accountName) || db.settings.accountName || "Joint Savings Account"
        };
        return saveAccountData(code, db).then(function() {
          res.status(200).json({ success: true, settings: db.settings, summary: computeSummary(db) });
        });
      }

      res.status(404).json({ error: "Route not found" });
    });
  }).catch(function(err) {
    console.error("Vercel Function Error:", err);
    res.status(500).json({ error: err.message });
  });
};
