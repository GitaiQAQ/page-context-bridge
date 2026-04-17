export interface RoutedPageTool {
  actualToolName: string;
  registeredToolName: string;
}

export function buildRegisteredPageToolName(tabId: number, actualToolName: string): string {
  return `tab.${tabId}.${actualToolName}`;
}

export function createRoutedPageTool(tabId: number, actualToolName: string): RoutedPageTool {
  return {
    actualToolName,
    registeredToolName: buildRegisteredPageToolName(tabId, actualToolName),
  };
}
