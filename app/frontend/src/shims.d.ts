interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_SYNC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module 'react-dom/client' {
  import type { ReactNode } from 'react';

  export interface Root {
    render(children: ReactNode): void;
    unmount(): void;
  }

  export function createRoot(container: Element | DocumentFragment): Root;
}

declare module 'tldraw' {
  export type TLRecord = {
    id: string;
    typeName?: unknown;
  };

  export type TLShape = TLRecord & {
    type?: string;
    props?: Record<string, unknown>;
    x?: number;
    y?: number;
    meta?: Record<string, unknown>;
  };

  export type TLStoreSnapshot = {
    store: Record<string, TLRecord>;
  };

  export interface StoreLike {
    getStoreSnapshot(): TLStoreSnapshot;
    put(records: TLShape[]): void;
    listen(listener: (entry: unknown) => void, options?: Record<string, unknown>): () => void;
  }

  export interface Editor {
    store: StoreLike;
    run(callback: () => void): void;
    createShapes(shapes: unknown[]): void;
    deleteShapes(shapeIds: string[]): void;
    getViewportPageBounds?(): {
      x: number;
      y: number;
      w?: number;
      h?: number;
      width?: number;
      height?: number;
    };
  }

  export function Tldraw(props: {
    persistenceKey?: string;
    onMount?: (editor: Editor) => void;
  }): JSX.Element;
}
