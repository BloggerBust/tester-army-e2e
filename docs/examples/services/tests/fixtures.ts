import { test as base } from 'e2e';
import type config from '../e2e.config.ts';

export const test = base.extend<{}, {}, typeof config>({});
