import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isDevBypassActive } from '../lib/devBypass.js'

test('active in dev with the opt-in var set', () => {
  assert.equal(isDevBypassActive({ NODE_ENV: 'development', DEV_BYPASS_AUTH: '1' }), true)
})

test('NODE_ENV=production always wins, even with the opt-in var set', () => {
  // The important one -- this must never be true on anything Vercel deploys.
  assert.equal(isDevBypassActive({ NODE_ENV: 'production', DEV_BYPASS_AUTH: '1' }), false)
})

test('inactive in dev without the opt-in var', () => {
  assert.equal(isDevBypassActive({ NODE_ENV: 'development', DEV_BYPASS_AUTH: undefined }), false)
})

test('inactive with an unset NODE_ENV, unless the opt-in var matches', () => {
  assert.equal(isDevBypassActive({ NODE_ENV: undefined, DEV_BYPASS_AUTH: '1' }), true)
  assert.equal(isDevBypassActive({ NODE_ENV: undefined, DEV_BYPASS_AUTH: undefined }), false)
})

test('requires exactly "1" -- not "true" or any other truthy string', () => {
  assert.equal(isDevBypassActive({ NODE_ENV: 'development', DEV_BYPASS_AUTH: 'true' }), false)
  assert.equal(isDevBypassActive({ NODE_ENV: 'development', DEV_BYPASS_AUTH: '0' }), false)
  assert.equal(isDevBypassActive({ NODE_ENV: 'development', DEV_BYPASS_AUTH: '' }), false)
})

test('test environment (NODE_ENV=test) is also non-production', () => {
  assert.equal(isDevBypassActive({ NODE_ENV: 'test', DEV_BYPASS_AUTH: '1' }), true)
})
