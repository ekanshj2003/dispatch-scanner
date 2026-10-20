# Dispatch Scan Register

Scan the **AWB label** and then the **packet barcode** of every Flipkart or Meesho parcel. Each pair is saved as one row in your Google Sheet with date, time, platform, product and who scanned it. Download any date range as Excel.

App link: https://ekanshj2003.github.io/dispatch-scanner/

- Each packer logs in with their own name and PIN.
- Scan with the phone camera, a USB/Bluetooth barcode gun, or by typing.
- The camera only reads barcodes inside the white box and waits for a clear read. If a label has more than one barcode, it asks you to tap the right one and remembers your choice.
- Duplicate AWBs are blocked.
- If the internet drops, scans are kept on the phone and uploaded later.

---

## Part 1 – Google Sheet (one time)

1. Create a blank Google Sheet named `Dispatch Register`.
2. **Extensions → Apps Script**. Delete everything, paste all of `google-sheet-script/Code.gs`, click **Save**.
3. Pick **setup** in the function list and click **Run**. Allow the permissions (**Advanced → Go to project → Allow**).
4. Open the new **Users** tab in the Sheet:
   - Change the Admin PIN from `1234` to your own.
   - Add one row per packer: Name, PIN, Role `packer`, Active `YES`.
   - Role `admin` can delete scans and name packet codes. Set Active to `NO` to block someone.
5. **Deploy → New deployment →** gear icon **→ Web app**. Execute as **Me**, Who has access **Anyone**. **Deploy**, then copy the link ending in `/exec`.

Already deployed the old script? Paste the new code, run **setup** again, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The link stays the same.

## Part 2 – Each phone (one time)

1. Open the app link in **Chrome**.
2. Tap **Connect this device**, paste the `/exec` link, tap **Save and test**.
3. Log in with your name and PIN. You stay logged in for 30 days.
4. Chrome menu (⋮) → **Add to Home screen**.

## Daily use

1. Pick **Flipkart** or **Meesho** at the top. AWBs starting with `FMP` switch to Flipkart by themselves.
2. Tap **Start camera** (only the first time; after that it starts by itself).
3. Hold the AWB barcode inside the white box. Beep and green flash = captured.
4. Hold the packet barcode inside the box. **✓ Saved** = done.
5. Red message with a long buzz = problem (for example a duplicate AWB).

Camera tips:
- Hold the phone 15–25 cm away, label flat, barcode lying across the box.
- Dark godown? Tap **Light**. Small barcode? Tap **2×**.
- On a Bluetooth barcode gun, just scan. No need to tap anything.

## Flipkart order check (optional)

When connected, scanning an AWB shows what should be inside the parcel, and a wrong packet is blocked with a red warning.

1. Flipkart Seller Hub → **Manage Profile → Developer Access → Self Access → Create New Access**. Keep the API key and secret private.
2. In Apps Script, click the **gear icon (Project Settings)** on the left → **Script Properties** → **Add script property**:
   - `FK_APP_ID` = the API key / Application ID
   - `FK_APP_SECRET` = the secret
   Click **Save script properties**.
3. Choose **setup** and click **Run**. Allow the new permission (it now contacts Flipkart). The log at the bottom should say **Flipkart connected**.
4. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**.
5. In the app, open **Codes** and add the **SKU** for each packet barcode (the same SKU as your Flipkart listing). Or just scan: after a parcel, the admin is asked "Is it …?" and one tap links it.

Orders refresh every 15 minutes. An admin can tap their name → **Sync Flipkart now**. The **Orders** tab in the Sheet shows what was pulled.

## Tabs

- **Scan** – the scanner and today's count.
- **Today** – totals by product and the full log. Pick any date at the top.
- **Excel** – choose dates and download. Sheet 1 has every parcel, Sheet 2 has totals.
- **Codes** (admin only) – name each packet barcode once, e.g. `Baby Pants M 30`.

## Problems

| What you see | What to do |
|---|---|
| "Name or PIN is wrong" | Check the Users tab. Names are not case-sensitive. |
| "Too many wrong PINs" | Wait 10 minutes. |
| "Paste the new Code.gs" | The Sheet still has the old script. See Part 1, last line. |
| Camera does not start | Chrome → ⋮ → Settings → Site settings → Camera → allow the app. |
| It asks "Tap the AWB" | Tap the right number once. Next time it chooses by itself. |
| "Waiting to upload" | Phone is offline. It uploads by itself when internet is back. |
