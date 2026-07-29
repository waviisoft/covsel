import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';

import { total } from '../../src/cart.mjs';
import { greet } from '../../src/greeting.mjs';

let result;

When('I total the prices {int} and {int}', function (a, b) {
  result = total([a, b]);
});

Then('the total is {int}', function (expected) {
  assert.equal(result, expected);
});

When('I greet {string}', function (name) {
  result = greet(name);
});

Then('the greeting is {string}', function (expected) {
  assert.equal(result, expected);
});
