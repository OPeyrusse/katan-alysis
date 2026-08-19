import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { TopMethodsTable } from './TopMethodsTable';
import type { Frame, TopMethods } from '../api/client';

const frames: Frame[] = [
  { class_name: 'App', method_name: 'main' },
  { class_name: 'App', method_name: 'hotLoop' },
];

const view: TopMethods = {
  rows: [
    [1, { self_samples: 3, total_samples: 3 }],
    [0, { self_samples: 1, total_samples: 4 }],
  ],
  total_samples: 4,
};

describe('TopMethodsTable', () => {
  it('renders one row per method, in backend order', () => {
    render(() => <TopMethodsTable frames={frames} view={view} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('App.hotLoop');
    expect(rows[1]).toHaveTextContent('App.main');
  });

  it('renders counts and percentages', () => {
    render(() => <TopMethodsTable frames={frames} view={view} />);
    const hotRow = screen.getByRole('row', { name: /App\.hotLoop/ });
    expect(hotRow).toHaveTextContent('3');
    expect(hotRow).toHaveTextContent('75.0%');
    const mainRow = screen.getByRole('row', { name: /App\.main/ });
    expect(mainRow).toHaveTextContent('25.0%');
    expect(mainRow).toHaveTextContent('100.0%');
  });

  it('falls back to the frame index for unknown frames', () => {
    render(() => (
      <TopMethodsTable
        frames={[]}
        view={{ rows: [[7, { self_samples: 1, total_samples: 1 }]], total_samples: 1 }}
      />
    ));
    expect(screen.getByRole('row', { name: /#7/ })).toBeInTheDocument();
  });

  it('renders method names as plain text without a selection handler', () => {
    render(() => <TopMethodsTable frames={frames} view={view} />);
    expect(screen.queryByRole('button', { name: 'App.hotLoop' })).not.toBeInTheDocument();
  });

  it('clicking a method name selects its frame', async () => {
    const onSelectFrame = vi.fn();
    render(() => <TopMethodsTable frames={frames} view={view} onSelectFrame={onSelectFrame} />);

    await userEvent.click(screen.getByRole('button', { name: 'App.hotLoop' }));
    expect(onSelectFrame).toHaveBeenCalledWith(1);
  });
});
