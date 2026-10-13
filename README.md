# Dispatch Scan Register

Scan the **AWB label** and then the **packet barcode** of every Flipkart or Meesho parcel. Each pair is saved as one row in your Google Sheet, with date, time, platform, product and packer name. Download any date range as Excel.

- Works on any phone or PC in Chrome.
- Scan with the phone camera, a USB/Bluetooth barcode gun, or by typing.
- Duplicate AWBs are blocked.
- If the internet drops, scans are kept on the phone and uploaded later.
- All packers share one Google Sheet, so totals are always live.

Setup takes about 15 minutes, once.

---

## Part 1 – Google Sheet (where data is saved)

1. Go to **sheets.google.com** and create a new blank sheet. Name it `Dispatch Register`.
2. In the menu click **Extensions → Apps Script**.
3. Delete everything in the editor. Open `google-sheet-script/Code.gs` from this folder, copy all of it, and paste it in.
4. On the line `const APP_KEY = 'change-me';` replace `change-me` with your own secret word, for example `jain2026pack`. Keep it private.
5. Click the **Save** icon.
6. In the function dropdown at the top choose **setup**, then click **Run**.
   - Google asks for permission. Click **Review permissions**, choose your account, then **Advanced → Go to project (unsafe) → Allow**. This warning appears because you wrote the script yourself.
   - Your Sheet now has three tabs: **Dispatch**, **Products**, **Summary**.
7. Click **Deploy → New deployment**.
   - Click the gear icon → **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy** and copy the **Web app URL** (it ends with `/exec`).

## Part 2 – Put the app on GitHub

1. Sign in at **github.com**.
2. Click **+** (top right) → **New repository**.
   - Name: `dispatch-scanner`
   - Choose **Public** (free GitHub Pages needs a public repo; your scan data stays in your Google Sheet, not on GitHub).
   - Click **Create repository**.
3. On the new repo page click **uploading an existing file**.
4. Drag in these files from this folder: `index.html`, `app.js`, `manifest.json`, `icon.svg`, `README.md`. (You can also drag the `google-sheet-script` folder for safekeeping.) Click **Commit changes**.
5. Go to **Settings → Pages**.
   - Source: **Deploy from a branch**
   - Branch: **main**, folder **/ (root)** → **Save**.
6. Wait 1–2 minutes and refresh. Your app link appears at the top, like
   `https://YOUR-USERNAME.github.io/dispatch-scanner/`

## Part 3 – Connect the app

1. Open the app link on your phone in **Chrome**.
2. Scroll to **Settings**:
   - Paste the **Web app URL** from Part 1.
   - Type the same **app key** you put in the script.
   - Type a name for this phone, for example `Packing table 1`.
   - Tap **Save and test**. It should say **Connected**.
3. Chrome menu (⋮) → **Add to Home screen**, so it opens like an app.
4. Repeat Part 3 on every phone or PC that will scan.

## Daily use

1. Choose **Flipkart** or **Meesho**. AWBs starting with `FMP` switch to Flipkart automatically.
2. Scan the **AWB barcode** on the shipping label.
3. Scan the **barcode on the packet**.
4. A green message and beep mean it is saved. Red with a long buzz means a problem (for example, a duplicate AWB).

Tips:
- **Camera:** tap **Use camera** and allow camera access. Hold the label flat, with the AWB barcode inside the box. Flipkart and Meesho labels have several barcodes, so aim at the one printed under or above the AWB number.
- **Barcode gun:** click once in the big scan box and scan. The gun types the code and presses Enter by itself. This is the fastest way for high volume.
- **Packet codes:** name each packet barcode once under **Packet codes** (for example `Baby Pants M 30`). Earlier scans of that barcode get the name too.
- **Mistake?** Tap **Delete** on the row, then **Confirm**.

## Excel

- In the app: choose From and To dates → **Download .xlsx**. You get a **Dispatch** sheet (every parcel) and a **Summary** sheet (count by date, platform and product).
- Or open the Google Sheet anytime: **File → Download → Microsoft Excel (.xlsx)**. The **Summary** tab updates by itself.

## Changing the script later

If you edit `Code.gs`, go to **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same.

## Problems

| What you see | What to do |
|---|---|
| "Wrong app key" | The key in Settings must match `APP_KEY` in the script exactly. |
| "Sheet missing. Run setup once" | Run the `setup` function in Apps Script (Part 1, step 6). |
| Camera does not start | Open the app with the `https://…github.io` link, not a downloaded file. Allow camera in Chrome site settings. |
| "Waiting to upload" stays | The phone is offline. Scans upload by themselves when the internet returns, or tap **Refresh**. |
| Could not connect | Check the URL ends with `/exec` and the deployment's access is **Anyone**. |
