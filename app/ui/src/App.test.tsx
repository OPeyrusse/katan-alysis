import { describe, expect, it } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { App } from './App';

describe('App', () => {
  it('renders the application shell', () => {
    render(() => <App />);
    expect(screen.getByRole('heading', { name: 'katan-alysis' })).toBeInTheDocument();
  });
});
