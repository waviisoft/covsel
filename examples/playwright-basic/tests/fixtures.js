// The one line covsel asks a Playwright project for. Outside a recording
// `covselFixtures()` returns nothing, so the selected runs -- almost every
// invocation -- are exactly what they were.
import { test as base, expect } from '@playwright/test';
import { covselFixtures } from '@covsel/adapter-playwright/fixture';

export const test = base.extend(covselFixtures());
export { expect };
