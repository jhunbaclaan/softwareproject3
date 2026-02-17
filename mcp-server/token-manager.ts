/**
 * TokenManager - Server-side OAuth token management with automatic refresh
 *
 * Replicates the token refresh logic from @audiotool/nexus's getOrFetchValidToken
 * for use in the MCP server environment.
 */

const TOKEN_ENDPOINT = "https://oauth.audiotool.com/oauth2/token";
const TOKEN_EXPIRY_BUFFER_MS = 60_000; // Refresh 60 seconds before expiry

export interface TokenConfig {
    accessToken: string;
    expiresAt: number;
    refreshToken?: string;
    clientId: string;
}

export class TokenManager {
    private accessToken: string;
    private expiresAt: number;
    private refreshToken?: string;
    private clientId: string;
    private refreshPromise?: Promise<void>;

    constructor(config: TokenConfig) {
        this.accessToken = config.accessToken;
        this.expiresAt = config.expiresAt;
        this.refreshToken = config.refreshToken;
        this.clientId = config.clientId;
    }

    /**
     * Returns a valid access token, refreshing it if necessary.
     * This method matches the signature expected by createAudiotoolClient.
     */
    async getToken(): Promise<string | Error> {
        try {
            // Check if token is expired or about to expire
            const isExpired = Date.now() >= this.expiresAt - TOKEN_EXPIRY_BUFFER_MS;

            if (!isExpired) {
                return this.accessToken;
            }

            // If no refresh token, cannot refresh
            if (!this.refreshToken) {
                return new Error("Token expired and no refresh token available");
            }

            // Prevent multiple simultaneous refresh attempts
            if (this.refreshPromise) {
                await this.refreshPromise;
                return this.accessToken;
            }

            // Start refresh process
            this.refreshPromise = this.refreshAccessToken();
            await this.refreshPromise;
            this.refreshPromise = undefined;

            return this.accessToken;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return new Error(`Token refresh failed: ${message}`);
        }
    }

    /**
     * Performs the actual token refresh by calling Audiotool's token endpoint.
     */
    private async refreshAccessToken(): Promise<void> {
        console.error("[TokenManager] Refreshing access token...");

        if (!this.refreshToken) {
            throw new Error("No refresh token available");
        }

        const response = await fetch(TOKEN_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                client_id: this.clientId,
                grant_type: "refresh_token",
                refresh_token: this.refreshToken,
            }),
        });

        if (!response.ok) {
            throw new Error(`Token refresh request failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        // Check for OAuth error response
        if (data.error) {
            const errorMsg = data.error_description || data.error;
            throw new Error(`OAuth error: ${errorMsg}`);
        }

        // Update stored tokens
        if (data.access_token) {
            this.accessToken = data.access_token;
            console.error("[TokenManager] Access token refreshed successfully");
        }

        if (data.refresh_token) {
            this.refreshToken = data.refresh_token;
        }

        if (data.expires_in) {
            // expires_in is in seconds, convert to timestamp
            this.expiresAt = Date.now() + (data.expires_in * 1000);
            console.error(`[TokenManager] Token will expire at: ${new Date(this.expiresAt).toISOString()}`);
        }
    }

    /**
     * Get current token expiration timestamp (for debugging)
     */
    getExpiresAt(): number {
        return this.expiresAt;
    }

    /**
     * Check if token is currently valid (for debugging)
     */
    isValid(): boolean {
        return Date.now() < this.expiresAt - TOKEN_EXPIRY_BUFFER_MS;
    }
}
