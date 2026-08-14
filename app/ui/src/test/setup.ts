import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@solidjs/testing-library';

// testing-library only auto-registers its cleanup when vitest exposes
// globals; we don't, so unmount rendered components explicitly.
afterEach(cleanup);
