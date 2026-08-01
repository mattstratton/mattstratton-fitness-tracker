import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isAllowed } from '../lib/allowlist.js'

test('admits the allowlisted, verified address', () => {
  assert.equal(isAllowed('matt.stratton@gmail.com', true), true)
})

test('admits it regardless of case or surrounding whitespace', () => {
  assert.equal(isAllowed('Matt.Stratton@Gmail.com', true), true)
  assert.equal(isAllowed('  matt.stratton@gmail.com  ', true), true)
})

test('refuses every other address', () => {
  for (const email of [
    'someone.else@gmail.com',
    'matt.stratton@gmail.com.evil.com',
    'evil.com/matt.stratton@gmail.com',
    'mattstratton@gmail.com',       // no dot -- Google treats as same inbox, we do not
    'matt.stratton+x@gmail.com',    // plus-addressing is a different string
    'matt.stratton@googlemail.com',
  ]) {
    assert.equal(isAllowed(email, true), false, `should refuse ${email}`)
  }
})

test('refuses an UNVERIFIED address even when it matches', () => {
  // The important one. On a Workspace domain email_verified can be false, and
  // an unverified address is a claim rather than an identity -- accepting it
  // would let someone assert any address they liked.
  assert.equal(isAllowed('matt.stratton@gmail.com', false), false)
  assert.equal(isAllowed('matt.stratton@gmail.com', undefined), false)
  assert.equal(isAllowed('matt.stratton@gmail.com', 'true'), false)
  assert.equal(isAllowed('matt.stratton@gmail.com', 1), false)
})

test('refuses missing or non-string emails', () => {
  for (const email of [undefined, null, '', 0, {}, []]) {
    assert.equal(isAllowed(email, true), false, `should refuse ${JSON.stringify(email)}`)
  }
})
