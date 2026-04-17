/**
 * CLI Arguments Configuration
 */

/** Supported actions with their CLI command names */
export interface ActionConfig {
  name: string;
  command: string;
  paramMap: Record<string, string | null>;
  arrayParams?: string[];
  boolParams?: string[];
}

/** All supported actions */
export const ACTIONS: Record<string, ActionConfig> = {
  run: {
    name: 'run',
    command: 'run',
    paramMap: {
      msg: 'msg',
      model: 'm',
      agent: 'agent',
      cmd: 'command',
      title: 'title',
      session: 's',
      files: 'f',
      share: 'share',
      mode: 'agent',
    },
    arrayParams: ['files', 'msg'],
    boolParams: ['share'],
  },
  session: {
    name: 'session',
    command: '',
    paramMap: {
      continue: 'c',
      session: 's',
    },
    boolParams: ['continue'],
  },
  attach: {
    name: 'attach',
    command: 'attach',
    paramMap: {
      url: null,
      session: 's',
    },
    boolParams: ['continue'],
  },
  web: {
    name: 'web',
    command: 'web',
    paramMap: {
      port: 'port',
      session: 's',
    },
  },
};
