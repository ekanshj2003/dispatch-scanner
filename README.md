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
- Flash turns on by itself; tap **Flash** to switch it off. Small barcode? Tap **2×**.
- On a Bluetooth barcode gun, just scan. No need to tap anything.

## Never scan twice

- An **AWB** can be saved only once, ever. Scanning it again shows a red "already scanned" with the date.
- A **packet barcode** can also be used only once, unless you change it in the Sheet's **Settings** tab: set *Packet barcode used only once* to `NO` if the same barcode is printed on every packet of a product.
- An AWB can never be used as a packet barcode, and the other way round.

## Meesho delivery partner

When **Meesho** is selected, tap the delivery partner under the top bar (Valmo, Delhivery, Shadowfax…) before scanning. The app remembers it until you change it. Edit the list in the Sheet's **Settings** tab. The **Today** tab shows parcels per delivery partner.

## Cancelled at pickup

Open the **Cancel** tab, pick a reason (Order cancelled, Courier did not pick up, Damaged, Other) and scan the parcel's AWB (camera, barcode gun, or type it).
- The parcel is **removed from Dispatch** and moved to the Sheet's **Cancelled** tab (with reason, who and when).
- Totals, manifest counts and Excel only count real dispatches.
- The AWB and packet barcode can be **scanned again** any time (e.g. next day when the courier comes) – it is a normal fresh scan.
- An admin can tap **Undo** to put it back into Dispatch if it was cancelled by mistake.

## Deleting a wrong entry

In **Today** (admin), tap **Delete** then **Sure?**. Both the AWB and the packet barcode can be scanned again straight away, on every phone. Every delete and cancel is recorded in the Sheet's **Changes Log** tab.

## Search

Type or scan any part of an AWB or packet barcode in the box at the top of **Today**. It searches all dates and shows the status, delivery partner and who scanned it, with Cancel / Undo / Delete buttons.

## Signed manifest

Open the **Manifest** tab, pick the platform and delivery partner, tap **Take photo or choose file** (one photo per page, or a PDF) and tap **Upload**. Files are saved in Google Drive › **Dispatch Manifests** › today's date, and listed in the Sheet's **Manifests** tab with the number of parcels scanned for that partner.

## Flipkart / Meesho order connection

Switched off in this version. The code is kept; it can be switched on later (set `PORTALS = true` at the top of app.js).

## Tabs

- **Scan** – the scanner and today's count.
- **Today** – totals by product and the full log. Pick any date at the top.
- **Excel** – choose dates and download. Sheet 1 has every parcel, Sheet 2 has totals.
- **Manifest** – upload the signed manifest photos; they go to Google Drive in today's folder.

## Problems

| What you see | What to do |
|---|---|
| "Name or PIN is wrong" | Check the Users tab. Names are not case-sensitive. |
| "Too many wrong PINs" | Wait 10 minutes. |
| "Paste the new Code.gs" | The Sheet still has the old script. See Part 1, last line. |
| Camera does not start | Chrome → ⋮ → Settings → Site settings → Camera → allow the app. |
| It asks "Tap the AWB" | Tap the right number once. Next time it chooses by itself. |
| "Waiting to upload" | Phone is offline. It uploads by itself when internet is back. |
