import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newer } from '../src/shared/version.ts'

test('version comparison for the update check', () => {
  assert.equal(newer('v0.2.0', '0.1.0'), true)
  assert.equal(newer('0.1.10', '0.1.9'), true)
  assert.equal(newer('v0.1.0', '0.1.0'), false)
  assert.equal(newer('0.0.9', '0.1.0'), false)
  assert.equal(newer('1.0.0', '0.9.9'), true)
  // pre-releases
  assert.equal(newer('0.3.0', '0.3.0-beta.1'), true, 'the final is newer than its beta')
  assert.equal(newer('0.3.0-beta.1', '0.3.0'), false)
  assert.equal(newer('0.3.0-beta.2', '0.3.0-beta.1'), true)
  assert.equal(newer('0.3.0-beta.10', '0.3.0-beta.9'), true)
  assert.equal(newer('0.3.0-beta.1', '0.3.0-beta.1'), false)
  assert.equal(newer('0.3.1-beta.1', '0.3.0'), true)
  assert.equal(newer('garbage', '0.1.0'), false, 'a hostile tag is never newer')
})
