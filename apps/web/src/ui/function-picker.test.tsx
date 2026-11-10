import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { FunctionPicker } from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Kinds of work (beta testers: "pretty limited scope and I don't have the option to add anything"). */
describe('FunctionPicker', () => {
  it('takes any kind of work the student types, a common one as its chip, never twice', async () => {
    const seen: string[][] = [];
    function Host() {
      const [v, setV] = useState<string[]>([]);
      seen.push(v);
      return <FunctionPicker value={v} onChange={setV} testIdPrefix="fn" />;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<Host />));
    const type = async (text: string) => {
      await act(async () => (host.querySelector('[data-testid="fn-own"]') as HTMLButtonElement).click());
      const input = host.querySelector('[data-testid="fn-own-input"]') as HTMLInputElement;
      await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
    };
    await type('Policy research');
    await type('  policy   research ');
    await type('product management');
    await type('');
    expect(seen.at(-1)).toEqual(['Policy research', 'pm']);
    expect(host.querySelector('[data-testid="fn-Policy research"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    act(() => root.unmount());
    host.remove();
  });
});
