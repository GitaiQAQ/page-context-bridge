import { afterEach, describe, expect, it, vi } from 'vitest';

// 直接从真实包导入，不再经过 re-export shim
import { enrichUiAnchorReactMetaInMainWorld } from '@page-context/agentation';

describe('enrichUiAnchorReactMetaInMainWorld', () => {
  const originalChrome = globalThis.chrome;
  const originalElementFromPointDescriptor = Object.getOwnPropertyDescriptor(
    document,
    'elementFromPoint',
  );

  afterEach(() => {
    vi.restoreAllMocks();
    restoreChromeGlobal(originalChrome);
    if (originalElementFromPointDescriptor) {
      Object.defineProperty(document, 'elementFromPoint', originalElementFromPointDescriptor);
    } else {
      Reflect.deleteProperty(document, 'elementFromPoint');
    }
    document.body.innerHTML = '';
  });

  it('skips script injection when reactPath/reactLeaf are both ready', async () => {
    const executeScript = vi.fn();
    installChromeMock({ executeScript });

    const uiAnchor = {
      cssSelector: '#target',
      meta: {
        reactPath: ['AppShell', 'SubmitButton'],
        reactLeaf: 'SubmitButton',
        source: 'agentation-main-world',
      },
    };

    const enriched = await enrichUiAnchorReactMetaInMainWorld(7, uiAnchor);

    expect(enriched).toEqual(uiAnchor);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('collects react metadata via cssSelector in MAIN world and merges into meta', async () => {
    const target = document.createElement('button');
    target.id = 'target';
    target.textContent = 'Submit';
    attachReactFiber(target, ['SubmitButton', 'AppShell']);
    document.body.appendChild(target);

    const executeScript = vi
      .fn()
      .mockImplementation(async (options: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
        const arg = (options.args?.[0] ?? {}) as { cssSelector?: string };
        return [{ result: options.func?.(arg) }];
      });
    installChromeMock({ executeScript });

    const enriched = await enrichUiAnchorReactMetaInMainWorld(9, {
      cssSelector: '#target',
      meta: {
        source: 'agentation-main-world',
      },
    });

    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 9 },
        world: 'MAIN',
      }),
    );
    expect(enriched?.meta).toEqual({
      source: 'agentation-main-world',
      reactPath: ['AppShell', 'SubmitButton'],
      reactLeaf: 'SubmitButton',
    });
  });

  it('falls back to rect center when cssSelector is invalid', async () => {
    const target = document.createElement('div');
    target.textContent = 'target';
    attachReactFiber(target, ['ListItem', 'ListPanel']);
    document.body.appendChild(target);

    const elementFromPoint = vi.fn().mockReturnValue(target);
    Object.defineProperty(document, 'elementFromPoint', {
      value: elementFromPoint,
      configurable: true,
      writable: true,
    });

    const executeScript = vi
      .fn()
      .mockImplementation(async (options: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
        const arg = (options.args?.[0] ?? {}) as {
          cssSelector?: string;
          rect?: { x: number; y: number; width: number; height: number };
        };
        return [{ result: options.func?.(arg) }];
      });
    installChromeMock({ executeScript });

    const enriched = await enrichUiAnchorReactMetaInMainWorld(11, {
      cssSelector: '###broken-selector',
      rect: { x: 10, y: 20, width: 40, height: 60 },
    });

    expect(elementFromPoint).toHaveBeenCalledWith(30, 50);
    expect(enriched?.meta).toEqual({
      reactPath: ['ListPanel', 'ListItem'],
      reactLeaf: 'ListItem',
    });
  });

  it('silently degrades when script execution fails', async () => {
    const executeScript = vi.fn().mockRejectedValue(new Error('cannot inject'));
    installChromeMock({ executeScript });

    const uiAnchor = {
      cssSelector: '#target',
      meta: {
        source: 'agentation-main-world',
      },
    };

    const enriched = await enrichUiAnchorReactMetaInMainWorld(12, uiAnchor);

    expect(enriched).toEqual(uiAnchor);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });
});

function attachReactFiber(element: Element, leafToRootNames: string[]): void {
  let leafFiber: Record<string, unknown> | null = null;
  let cursor: Record<string, unknown> | null = null;

  for (const name of leafToRootNames) {
    const node = {
      type: {
        displayName: name,
      },
      return: null,
    };

    if (!leafFiber) {
      leafFiber = node;
      cursor = node;
      continue;
    }

    (cursor as Record<string, unknown>).return = node;
    cursor = node;
  }

  if (!leafFiber) {
    return;
  }

  // Simulate React DOM mounting fiber expando key on real element.
  (element as unknown as Record<string, unknown>).__reactFiber$test = leafFiber;
}

function installChromeMock({ executeScript }: { executeScript?: ReturnType<typeof vi.fn> }): void {
  const chromeMock = {
    scripting: {
      executeScript: executeScript ?? vi.fn(),
    },
  } as unknown as typeof chrome;

  Object.defineProperty(globalThis, 'chrome', {
    value: chromeMock,
    configurable: true,
    writable: true,
  });
}

function restoreChromeGlobal(originalChrome: typeof chrome | undefined): void {
  if (originalChrome) {
    Object.defineProperty(globalThis, 'chrome', {
      value: originalChrome,
      configurable: true,
      writable: true,
    });
    return;
  }
  Reflect.deleteProperty(globalThis, 'chrome');
}
