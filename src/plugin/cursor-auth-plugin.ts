import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
  refreshCursorToken,
} from "../auth";
import { CURSOR_PROVIDER_ID } from "../constants";
import {
  configurePluginLogger,
  errorDetails,
  logPluginError,
  logPluginWarn,
} from "../logger";
import { getCursorModels, type CursorModel } from "../models";
import {
  buildCursorProviderModels,
  buildDisabledProviderConfig,
  setProviderModels,
  stripAuthorizationHeader,
} from "../provider/models";
import { startProxy, stopProxy } from "../proxy";

let lastModelDiscoveryError: string | null = null;

export const CursorAuthPlugin: Plugin = async (
  input: PluginInput,
): Promise<Hooks> => {
  configurePluginLogger(input);

  return {
    auth: {
      provider: CURSOR_PROVIDER_ID,

      async loader(getAuth, provider) {
        try {
          const auth = await getAuth();
          if (!auth || auth.type !== "oauth") return {};

          let accessToken = auth.access;
          if (!accessToken || auth.expires < Date.now()) {
            const refreshed = await refreshCursorToken(auth.refresh);
            await input.client.auth.set({
              path: { id: CURSOR_PROVIDER_ID },
              body: {
                type: "oauth",
                refresh: refreshed.refresh,
                access: refreshed.access,
                expires: refreshed.expires,
              },
            });
            accessToken = refreshed.access;
          }

          const models: CursorModel[] = await getCursorModels(accessToken);
          lastModelDiscoveryError = null;
          const port = await startProxy(async () => {
            const currentAuth = await getAuth();
            if (currentAuth.type !== "oauth") {
              const authError = new Error("Cursor auth not configured");
              logPluginError("Cursor proxy access token lookup failed", {
                stage: "proxy_access_token",
                ...errorDetails(authError),
              });
              throw authError;
            }

            if (!currentAuth.access || currentAuth.expires < Date.now()) {
              const refreshed = await refreshCursorToken(currentAuth.refresh);
              await input.client.auth.set({
                path: { id: CURSOR_PROVIDER_ID },
                body: {
                  type: "oauth",
                  refresh: refreshed.refresh,
                  access: refreshed.access,
                  expires: refreshed.expires,
                },
              });
              return refreshed.access;
            }

            return currentAuth.access;
          }, models);

          setProviderModels(provider, buildCursorProviderModels(models, port));

          return {
            baseURL: `http://localhost:${port}/v1`,
            apiKey: "cursor-proxy",
            async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
              return fetch(requestInput, stripAuthorizationHeader(init));
            },
          };
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Cursor model discovery failed.";

          logPluginError("Cursor auth loader failed", {
            stage: "loader",
            providerID: CURSOR_PROVIDER_ID,
            ...errorDetails(error),
          });

          stopProxy();
          setProviderModels(provider, {});

          if (message !== lastModelDiscoveryError) {
            lastModelDiscoveryError = message;
            await showDiscoveryFailureToast(input, message);
          }

          return buildDisabledProviderConfig(message);
        }
      },

      methods: [
        {
          type: "oauth",
          label: "Login with Cursor",
          async authorize() {
            const { verifier, uuid, loginUrl } =
              await generateCursorAuthParams();

            return {
              url: loginUrl,
              instructions:
                "Complete login in your browser. This window will close automatically.",
              method: "auto" as const,
              async callback() {
                const { accessToken, refreshToken } = await pollCursorAuth(
                  uuid,
                  verifier,
                );

                return {
                  type: "success" as const,
                  refresh: refreshToken,
                  access: accessToken,
                  expires: getTokenExpiry(accessToken),
                };
              },
            };
          },
        },
      ],
    },

    async "chat.headers"(incoming, output) {
      if (incoming.model.providerID !== CURSOR_PROVIDER_ID) return;

      output.headers["x-session-id"] = incoming.sessionID;
      if (incoming.agent) {
        output.headers["x-opencode-agent"] = incoming.agent;
      }
    },
  };
};

async function showDiscoveryFailureToast(
  input: PluginInput,
  message: string,
): Promise<void> {
  try {
    await input.client.tui.showToast({
      body: {
        title: "Cursor plugin disabled",
        message,
        variant: "error",
        duration: 8_000,
      },
    });
  } catch (error) {
    logPluginWarn("Failed to display Cursor plugin toast", {
      title: "Cursor plugin disabled",
      message,
      ...errorDetails(error),
    });
  }
}

export default CursorAuthPlugin;
