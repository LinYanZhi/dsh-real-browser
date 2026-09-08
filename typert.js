/**
 * dsh-real-browser — Host 面 Typert manifest（由 typert-loader 自动扫描注册）。
 *
 * 手写清单，结构与 @deepseek-ai/dsh-typert-generator 产物一致：
 * `./typert` 导出 TYPERT，invocations 的 codec 必须是 zod v4 实例。
 * namespace 'realBrowser' → 客户端通过 `ctx.remote.realBrowser.<method>` 调用。
 *
 * 实现位于 host.js 注册的 `realBrowser` Cordis service。
 */

import { z } from 'zod'

const strictCodec = (typeSymbol, schema) => ({ mode: 'strict', typeSymbol, schema })
const anyCodec = (symbol) => strictCodec(symbol, z.any())

const envResult = anyCodec('dsh-real-browser#EnvironmentResult')
const instancesResult = anyCodec('dsh-real-browser#InstancesResult')
const launchResult = anyCodec('dsh-real-browser#LaunchResult')
const closeResult = strictCodec('dsh-real-browser#CloseResult', z.object({ killed: z.number() }))

const boolOpt = strictCodec('dsh-real-browser#BooleanOption', z.boolean().optional())
const boolReq = strictCodec('dsh-real-browser#RequiredBoolean', z.boolean())
const strOpt = strictCodec('dsh-real-browser#StringOption', z.string().optional())
const numOpt = strictCodec('dsh-real-browser#NumberOption', z.number().optional())
const strReq = strictCodec('dsh-real-browser#RequiredString', z.string())
const numReq = strictCodec('dsh-real-browser#RequiredNumber', z.number())
const exePathsPatch = strictCodec('dsh-real-browser#ExePathsPatch', z.record(z.string(), z.string()).nullish())
const userDataDirsPatch = strictCodec('dsh-real-browser#UserDataDirsPatch', z.record(z.string(), z.array(z.string())).nullish())

const param = (name, codec) => ({ name, wire: name, source: 'json', codec })

export const TYPERT = {
  package: 'dsh-real-browser',
  face: 'host',
  schemas: [],
  model: {
    services: [
      {
        key: 'realBrowser',
        exportName: 'RealBrowser',
        description:
          'Real-browser driving service backing the DSH web "浏览器设置" settings section: environment detection, running instances, launch/attach/takeover, and close.',
        summary: 'Real-browser driving service.',
        tags: [],
        members: [
          {
            kind: 'method',
            name: 'detectEnv',
            signature: 'detectEnv(includeAvatars?: boolean): Promise<{ browsers: unknown[] }>',
          },
          {
            kind: 'method',
            name: 'listRunning',
            signature: 'listRunning(): Promise<{ instances: unknown[] }>',
          },
          {
            kind: 'method',
            name: 'getAllowlist',
            signature: 'getAllowlist(): Promise<{ environments: unknown[] }>',
          },
          {
            kind: 'method',
            name: 'setAllowed',
            signature: 'setAllowed(args: { kind: string; userDataDir: string; profileId?: string; allowed: boolean }): Promise<{ environments: unknown[] }>',
          },
          {
            kind: 'method',
            name: 'launch',
            signature: 'launch(options: { exePath: string; userDataDir: string; profileId?: string; port?: number; url?: string; headless?: boolean; force?: boolean }): Promise<unknown>',
          },
          {
            kind: 'method',
            name: 'close',
            signature: 'close(options: { port: number }): Promise<{ killed: number }>',
          },
          {
            kind: 'method',
            name: 'getPolicy',
            signature: 'getPolicy(): Promise<{ deny: string[]; requireApproval: string[] }>',
          },
          {
            kind: 'method',
            name: 'policyAdd',
            signature: 'policyAdd(options: { kind: string; pattern: string }): Promise<{ policy: unknown }>',
          },
          {
            kind: 'method',
            name: 'policyRemove',
            signature: 'policyRemove(options: { kind: string; pattern: string }): Promise<{ policy: unknown }>',
          },
          {
            kind: 'method',
            name: 'getWorkMode',
            signature: 'getWorkMode(): Promise<{ sensitive: boolean }>',
          },
          {
            kind: 'method',
            name: 'setWorkMode',
            signature: 'setWorkMode(options: { enabled: boolean }): Promise<{ sensitive: boolean }>',
          },
          {
            kind: 'method',
            name: 'getConfig',
            signature: 'getConfig(): Promise<{ exePaths: object; userDataDirs: object; updatedAt?: string }>',
          },
          {
            kind: 'method',
            name: 'setConfig',
            signature: 'setConfig(exePaths?: object, userDataDirs?: object): Promise<object>',
          },
          {
            kind: 'method',
            name: 'getLaunchCommand',
            signature: 'getLaunchCommand(exePath: string, userDataDir: string, profileId?: string, port?: number): Promise<{ exe_path: string; args: string[]; command_line: string; debug_port: number }>',
          },
          {
            kind: 'method',
            name: 'createUserDataDir',
            signature: 'createUserDataDir(kind: string, parentDir: string, dirName: string): Promise<{ path: string; created: boolean; existed: boolean }>',
          },
          {
            kind: 'method',
            name: 'createShortcut',
            signature: 'createShortcut(kind: string, exePath: string, profileId: string, userDataDir: string, profileName: string, port?: number): Promise<{ shortcut_path: string; overwritten: boolean }>',
          },
          {
            kind: 'method',
            name: 'closeProfile',
            signature: 'closeProfile(kind: string, userDataDir: string, profileId?: string): Promise<{ killed: number; pids: number[] }>',
          },
          {
            kind: 'method',
            name: 'killAll',
            signature: 'killAll(kind: string): Promise<{ killed: number }>',
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: [
    {
      id: 'dsh-real-browser#realBrowser/detectEnv',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'detectEnv',
      invocation: { kind: 'direct' },
      parameters: [
        param('includeAvatars', boolOpt),
        param('force', boolOpt),
      ],
      result: envResult,
    },
    {
      id: 'dsh-real-browser#realBrowser/listRunning',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'listRunning',
      invocation: { kind: 'direct' },
      parameters: [],
      result: instancesResult,
    },
    {
      id: 'dsh-real-browser#realBrowser/getAllowlist',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'getAllowlist',
      invocation: { kind: 'direct' },
      parameters: [],
      result: anyCodec('dsh-real-browser#AllowlistResult'),
    },
    {
      id: 'dsh-real-browser#realBrowser/setAllowed',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'setAllowed',
      invocation: { kind: 'direct' },
      parameters: [
        param('kind', strReq),
        param('userDataDir', strReq),
        param('profileId', strOpt),
        param('allowed', boolReq),
      ],
      result: anyCodec('dsh-real-browser#AllowlistResult'),
    },
    {
      id: 'dsh-real-browser#realBrowser/launch',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'launch',
      invocation: { kind: 'direct' },
      parameters: [
        param('exePath', strReq),
        param('userDataDir', strReq),
        param('profileId', strOpt),
        param('port', numOpt),
        param('url', strOpt),
        param('headless', boolOpt),
        param('force', boolOpt),
      ],
      result: launchResult,
    },
    {
      id: 'dsh-real-browser#realBrowser/close',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'close',
      invocation: { kind: 'direct' },
      parameters: [
        param('port', numReq),
      ],
      result: closeResult,
    },
    {
      id: 'dsh-real-browser#realBrowser/getPolicy',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'getPolicy',
      invocation: { kind: 'direct' },
      parameters: [],
      result: anyCodec('dsh-real-browser#PolicyResult'),
    },
    {
      id: 'dsh-real-browser#realBrowser/policyAdd',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'policyAdd',
      invocation: { kind: 'direct' },
      parameters: [
        param('kind', strReq),
        param('pattern', strReq),
      ],
      result: anyCodec('dsh-real-browser#PolicyResult'),
    },
    {
      id: 'dsh-real-browser#realBrowser/policyRemove',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'policyRemove',
      invocation: { kind: 'direct' },
      parameters: [
        param('kind', strReq),
        param('pattern', strReq),
      ],
      result: anyCodec('dsh-real-browser#PolicyResult'),
    },
    {
      id: 'dsh-real-browser#realBrowser/getWorkMode',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'getWorkMode',
      invocation: { kind: 'direct' },
      parameters: [],
      result: anyCodec('dsh-real-browser#WorkModeResult'),
    },
    {
      id: 'dsh-real-browser#realBrowser/setWorkMode',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'setWorkMode',
      invocation: { kind: 'direct' },
      parameters: [
        param('enabled', boolReq),
      ],
      result: anyCodec('dsh-real-browser#WorkModeResult'),
    },
    {
      id: 'dsh-real-browser#realBrowser/getConfig',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'getConfig',
      invocation: { kind: 'direct' },
      parameters: [],
      result: anyCodec('dsh-real-browser#ConfigResult'),
    },
    {
      id: 'dsh-real-browser#realBrowser/setConfig',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'setConfig',
      invocation: { kind: 'direct' },
      parameters: [
        param('exePaths', exePathsPatch),
        param('userDataDirs', userDataDirsPatch),
      ],
      result: anyCodec('dsh-real-browser#ConfigResult'),
    },
    {
      id: 'dsh-real-browser#realBrowser/getLaunchCommand',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'getLaunchCommand',
      invocation: { kind: 'direct' },
      parameters: [
        param('exePath', strReq),
        param('userDataDir', strReq),
        param('profileId', strOpt),
        param('port', numOpt),
      ],
      result: anyCodec('dsh-real-browser#LaunchCommandResult'),
    },
    {
      id: 'dsh-real-browser#realBrowser/createUserDataDir',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'createUserDataDir',
      invocation: { kind: 'direct' },
      parameters: [
        param('kind', strReq),
        param('parentDir', strReq),
        param('dirName', strReq),
      ],
      result: anyCodec('dsh-real-browser#CreateUserDataDirResult'),
    },
    {
      id: 'dsh-real-browser#realBrowser/createShortcut',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'createShortcut',
      invocation: { kind: 'direct' },
      parameters: [
        param('kind', strReq),
        param('exePath', strReq),
        param('profileId', strReq),
        param('userDataDir', strReq),
        param('profileName', strReq),
        param('port', numOpt),
      ],
      result: anyCodec('dsh-real-browser#CreateShortcutResult'),
    },
    {
      id: 'dsh-real-browser#realBrowser/closeProfile',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'closeProfile',
      invocation: { kind: 'direct' },
      parameters: [
        param('kind', strReq),
        param('userDataDir', strReq),
        param('profileId', strOpt),
      ],
      result: anyCodec('dsh-real-browser#CloseProfileResult'),
    },
    {
      id: 'dsh-real-browser#realBrowser/killAll',
      service: 'realBrowser',
      namespace: 'realBrowser',
      method: 'killAll',
      invocation: { kind: 'direct' },
      parameters: [
        param('kind', strReq),
      ],
      result: anyCodec('dsh-real-browser#KillAllResult'),
    },
  ],
  events: [],
  objects: [],
}

export default TYPERT
