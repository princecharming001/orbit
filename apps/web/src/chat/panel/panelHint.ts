/**
 * What the side panel currently shows, kept outside React so the chat engine can tell the model ("Open panel: ...")
 * and "make it shorter" knows what "it" is. The panel host sets it on open, navigation and close.
 */
export interface PanelHint {
  /** the in-app route the panel shows, e.g. "/people/p4" or "/inbox?draft=out_1" */
  href: string;
  /** the panel's title in words, e.g. "Daniel Okafor" or "Pipeline" */
  title: string;
}

let hint: PanelHint | undefined;

export function getPanelHint(): PanelHint | undefined {
  return hint;
}

export function setPanelHint(next: PanelHint | undefined): void {
  hint = next;
}
