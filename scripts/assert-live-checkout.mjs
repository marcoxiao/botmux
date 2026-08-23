#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { assertLiveCheckout } from './live-checkout-pin.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
assertLiveCheckout(repoRoot);
