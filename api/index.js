'use strict';

// Vercel serverless entry. vercel.json rewrites /api/* to this function.
const { createApp } = require('../lib/app');
const { createStore } = require('../lib/store');

const app = createApp({ store: createStore(process.env) });

module.exports = (req, res) => app.handle(req, res);
