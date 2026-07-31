import { test } from 'node:test'
import assert from 'node:assert/strict'

import { requireBearer } from '../lib/http.js'

function req(auth?: string): Request {
  return new Request('https://example.test/api/hae', {
    method: 'POST',
    headers: auth === undefined ? {} : { authorization: auth },
  })
}

function withEnv(value: string | undefined, fn: () => void) {
  const before = process.env['TEST_TOKEN']
  try {
    if (value === undefined) delete process.env['TEST_TOKEN']
    else process.env['TEST_TOKEN'] = value
    fn()
  } finally {
    if (before === undefined) delete process.env['TEST_TOKEN']
    else process.env['TEST_TOKEN'] = before
  }
}

test('accepts the right token', () => {
  withEnv('s3cret', () => {
    assert.equal(requireBearer(req('Bearer s3cret'), 'TEST_TOKEN'), null)
  })
})

test('accepts a bare token without the Bearer prefix', () => {
  // HAE's header editor makes it easy to paste just the token.
  withEnv('s3cret', () => {
    assert.equal(requireBearer(req('s3cret'), 'TEST_TOKEN'), null)
  })
})

test('rejects a wrong, absent, or truncated token', () => {
  withEnv('s3cret', () => {
    for (const h of [undefined, '', 'Bearer wrong', 'Bearer s3cre', 'Bearer s3crett']) {
      const res = requireBearer(req(h), 'TEST_TOKEN')
      assert.ok(res, `expected rejection for ${JSON.stringify(h)}`)
      assert.equal(res!.status, 401)
    }
  })
})

test('an UNSET secret fails closed, it does not disable auth', () => {
  // The dangerous default is "no secret configured means skip the check", which
  // is how an endpoint taking personal health data ends up open to the internet
  // because someone forgot an environment variable. Must be a 500, and must
  // reject even a request that presents no token at all.
  withEnv(undefined, () => {
    const res = requireBearer(req('Bearer anything'), 'TEST_TOKEN')
    assert.ok(res)
    assert.equal(res!.status, 500)
    assert.equal(requireBearer(req(), 'TEST_TOKEN')!.status, 500)
  })
})

test('an empty-string secret also fails closed', () => {
  // `VAR=` in a dashboard is a very easy mistake, and an empty expected token
  // would otherwise match an empty presented token.
  withEnv('', () => {
    assert.equal(requireBearer(req('Bearer '), 'TEST_TOKEN')!.status, 500)
  })
})
