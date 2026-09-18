'use strict';

const STATUS_BY_CODE = {
  unauthorized: 401,
  payload_too_large: 413,
  invalid_json: 400,
  invalid_diff: 422,
  idempotency_conflict: 409,
  not_found: 404,
  rate_limited: 429,
  internal: 500,
};

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const headers = Object.assign(
    { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    extraHeaders || {}
  );
  res.writeHead(status, headers);
  res.end(body);
}

function sendError(res, code, message, extraHeaders) {
  const status = STATUS_BY_CODE[code] || 500;
  sendJson(res, status, { error: { code, message } }, extraHeaders);
}

module.exports = { sendError, sendJson, STATUS_BY_CODE };
