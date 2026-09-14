/**
 * Local type augmentation for the directoryPicker Remote namespace.
 *
 * The RUNNING harness (current npm checkout) serves `ctx.remote.directoryPicker`
 * through dsh-api-workspace-controller, but the pinned rc.6 type graph this
 * plugin compiles against predates the namespace's entry into the generated
 * client assembly, so the declaration does not exist locally. The runtime
 * contract comes from the Host's generated artifact (typert.remote-client.d.ts):
 *
 *   pick: (signal?: AbortSignal) => Promise<RemoteResult<string | null>>
 *
 * Only the verb this plugin uses is declared; unsupported backends refuse the
 * verb on the wire, which the caller handles as a plain failure.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    directoryPicker: {
      pick: (signal?: AbortSignal) => Promise<RemoteResult<string | null>>
    }
  }
}
