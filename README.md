# 💑 DuoSave RWF - Couple Shared Bank & Loan Tracker

A shared bank account management app specifically tailored for couples saving together with a **10,000 RWF monthly deposit rule** per partner.

---

## 🌟 Key Features

1. **Joint Current Balance**:
   - Live combined bank balance (all deposits + repayments - active loans).
   - Breakdown of how much each partner has deposited to date.
   - Net share calculation (Deposits minus any active borrowed loan).

2. **Monthly Savings Tracker (10k RWF Rule)**:
   - Tracks if both of you have deposited your **10,000 RWF** for the month.
   - Shows status: `✅ 10k Deposited` or `⏳ Due: 10,000 RWF`.
   - Records the **exact Date and Time** when the deposit occurred.
   - 1-Click deposit buttons for each partner.

3. **Loan Tracking & Repayment**:
   - If either partner needs to borrow money from the joint savings account, record a **Loan**.
   - Tracks borrower, amount, reason, date & time taken, and due date.
   - Automatically deducts the borrowed amount from available joint bank balance.
   - Allows recording full or partial repayments with timestamps, immediately restoring account balance.

4. **Real-Time Calendar ("Currendal")**:
   - Interactive live monthly calendar with ticking real-time clock.
   - Highlights days with visual indicators:
     - 🔵 **Blue badge**: Partner 1 deposit
     - 🌸 **Pink badge**: Partner 2 deposit
     - 🟠 **Amber badge**: Loan taken
     - 🟢 **Green badge**: Loan repaid
   - Click on any calendar date to see the exact time and breakdown of activities on that day.

5. **Detailed Transaction History & CSV Export**:
   - Filter transactions by type (Deposits, Loans, Repayments) or partner.
   - Export all transaction logs to a `.csv` spreadsheet file with one click.
   - Backup or restore all data as `.json`.

6. **Customizable Partner Names**:
   - Click the ⚙️ Settings icon to set your names (e.g. your name & your girlfriend's name), monthly target, or currency.

---

## 🚀 How to Run the App

### Option A: 1-Click Launch (Recommended on Windows)
Simply double-click the **`start.bat`** file in this folder. It will launch the local server and automatically open the app in your default web browser at `http://localhost:3000`.

### Option B: Using Command Line
Open PowerShell or Command Prompt in this folder:
```powershell
node server.js
```
Then visit `http://localhost:3000` in your web browser.

### Option C: Standalone Offline Mode (Without Server)
You can simply double-click **`public/index.html`** to open it directly in Google Chrome, Edge, or Firefox. The app automatically saves all your records inside your browser's local storage!
