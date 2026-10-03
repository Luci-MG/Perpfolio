// http.js — request guards shared by the routes: JSON-only bodies for every write, and the
// Host allowlist that keeps a page on another site from reading the API through DNS rebinding.

import express from 'express';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Middleware accepting only an `application/json` body up to `limit`: 415 otherwise, 400 when malformed. A cross-site page cannot send that type without a CORS preflight, which this server never grants. */
export function jsonOnly(limit) {
  const parse = express.json({ limit });
  return (req, res, next) => {
    if (!req.is('application/json')) return res.status(415).json({ ok: false, error: 'send application/json' });
    parse(req, res, err => (err ? res.status(400).json({ ok: false, error: 'malformed JSON' }) : next()));
  };
}

/** Middleware answering 403 to any request whose Host is not this machine or one of `extra`. */
export function allowedHostsOnly(extra = []) {
  const allowed = new Set([...LOCAL_HOSTS, ...extra.map(h => h.toLowerCase())]);
  return (req, res, next) => (allowed.has(hostName(req.headers.host))
    ? next() : res.status(403).json({ ok: false, error: 'host not allowed' }));
}

const hostName = host => (host || '').toLowerCase().replace(/:\d+$/, '');
