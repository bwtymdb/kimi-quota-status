# Kimi membership quota

Shows Kimi membership usage as a compact item in the existing composer dock.

## Setup and use

1. In **Settings → Models**, configure `KIMI_API_KEY` for the Kimi model.
2. In **Settings → Plugins**, enable **Kimi membership quota**.
3. Refresh any already-open pages.

API-provided monthly usage always takes priority and requires no browser login. Only when the API does not provide monthly usage does the browser supplement require the Chrome browser selected for web-access and a running local web-access Proxy. The plugin does not automatically open a browser when it starts.

The dock shows 5-hour, weekly, and monthly **used** quota. Click the item, or focus it and press Enter or Space, to force a refresh or retry.

If the API does not provide monthly usage and you choose the browser supplement, click the dock item for the first monthly login. The plugin uses the local web-access Proxy to open the Kimi subscription page in a background tab that it creates in the selected Chrome browser. If Kimi reports `login-required`, the tab stays open: log in manually in Chrome, then click the item again. The plugin never enters an account name or password. After a successful read it closes the tab. It only operates its own tab, and disabling or unloading the plugin cleans up that tab and its automatic work.

## Requests and privacy

The 5-hour and weekly values continue to use the original API channel. The Host resolves `KIMI_API_KEY` again for every API request. The Client receives only secret-free quota snapshots; it never receives the credential or calls Kimi directly.

When the API does not provide monthly usage, the monthly value is supplemented through the browser flow above. After a successful monthly browser read, the subscription page is read every 10 minutes. The 5-hour and weekly API reads keep their original 60-second cache and refresh cycle, and the dock also refreshes every 60 seconds. Clicking forces a retry. API requests time out after 10 seconds, concurrent reads are deduplicated, and errors retain the last successful values.

The plugin does not save cookies, page tokens, or full page text. It includes no automatic account name or password entry. Browser automation may trigger Kimi automation detection and account restrictions or other account risk. Monthly browser actions occur only when you click or on the approved 10-minute schedule after a successful monthly read.

## Meaning and scope

All percentages are **used**, so higher percentages mean more quota consumed. For example, **40%** means 40% of the applicable quota has been consumed. The monthly window follows the plan's billing-cycle month rather than necessarily a calendar month. **No limit (不限)** means the plan has no applicable cap. **—** means the value is unavailable or was not provided, not that quota is exhausted.

This plugin does not include Kimi Open Platform usage, multiple accounts, Extra Usage, history, or alerts. Disabling it removes only this dock item, stops its automatic reads, and disposes of any plugin-created monthly tab; it does not delete model settings or stored credentials.
