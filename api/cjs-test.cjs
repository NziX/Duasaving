module.exports = function(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, type: 'cjs', time: new Date().toISOString() }));
};
