# 🧭 Agent Instructions: Re‑Plan & Re‑Implement the File Transfer System

These instructions tell the agent **exactly how to redesign, implement, and integrate** the new transfer system.

---

## 1. 🎯 Core Goals (What the agent must achieve)

- **Unified Transfer Session** — A user‑initiated action (drag‑drop, upload folder, download folder, multi‑select) must create **one logical transfer**, not one per file.
- **Multi‑File Awareness** — Each transfer session tracks:
  - total files  
  - completed files  
  - pending files  
  - total bytes  
  - bytes transferred  
- **Bulk Mode Support** — When transferring folders or many files:
  - compress → upload → decompress (upload)  
  - compress → download → decompress (download)  
- **Show All Transfers** — TransferManager must display:
  - single‑file transfers  
  - multi‑file transfers  
  - bulk transfers  
- **Completion Notification** — Play a sound when a transfer session finishes.
- **Progress Aggregation** — UI progress = aggregated progress of all files in the session.

---

## 2. 🏗️ Architecture the Agent Must Build

### **A. TransferOrchestrator (new layer above SftpClient)**  
Responsible for:
- interpreting user actions  
- deciding between:
  - single‑file transfer  
  - multi‑file transfer  
  - bulk transfer  
- creating a **TransferSession**  
- registering the session with TransferManager  
- coordinating compression/extraction  
- delegating actual I/O to SftpClient  

---

### **B. TransferSession (new data model)**  
Each session contains:

| Field | Meaning |
|------|---------|
| id | unique session ID |
| type | upload / download |
| fileCountTotal | number of files in session |
| fileCountCompleted | number completed |
| bytesTotal | total bytes across all files |
| bytesTransferred | aggregated progress |
| status | running / completed / cancelled / failed |
| children | list of per‑file operations |

---

### **C. BulkTransferEngine (new module)**  
Handles:
- directory walking  
- local compression  
- remote compression  
- archive upload/download  
- extraction  
- cleanup  

---

### **D. SftpClient (existing) — modify, don’t overload**  
SftpClient must remain a **low‑level I/O layer**.  
Agent must NOT put orchestration logic here.

Required changes:
- expose `readFileStream()` and `writeFileStream()`  
- expose `exec()` for remote compression/extraction  
- do **not** call TransferManager directly  


---

### **E. TransferManager (existing) — extend functionality**  
Agent must update TransferManager to:

- accept **TransferSession** objects  
- show **all transfers**, not only bulk  
- aggregate progress from child operations  
- allow cancellation of entire session  
- allow cancellation of individual files  
- play completion sound  


---

## 3. 🔄 Required Behavioral Changes for the Agent

### **1. When user drags N files → create ONE TransferSession**
Agent must:
- detect multi‑file drag  
- compute total bytes  
- create a single session  
- add N child operations  
- choose bulk mode if:
  - N > threshold  
  - or directory transfer  
  - or user preference  


---

### **2. When user transfers a folder → bulk mode**
Agent must:
- walk directory  
- compute total size  
- compress folder  
- upload archive  
- extract remotely  
- update progress  


---

### **3. When user downloads a folder → bulk mode**
Agent must:
- run remote compression  
- download archive  
- extract locally  
- update progress  


---

### **4. When user transfers a single file → single‑file mode**
Agent must:
- create a session with 1 child  
- use SftpClient streaming  
- update progress  


---

## 4. 📊 TransferManager UI Requirements

Agent must ensure UI shows:

### **A. One row per TransferSession**
Not per file.

### **B. Columns**
- Name (e.g., “Upload 12 files”)  
- Progress bar (aggregated)  
- Status  
- Speed (optional)  
- ETA (optional)  

### **C. Expandable view**
Shows:
- each file  
- per‑file progress  
- errors  


---

## 5. 🔔 Completion Notification

Agent must implement:
- sound on success  
- sound on failure  
- optional toast notification  


---

## 6. 🧪 Testing Requirements

Agent must create tests for:

- single‑file upload  
- multi‑file upload  
- folder upload (bulk)  
- folder download (bulk)  
- cancellation mid‑transfer  
- cancellation of entire session  
- cancellation of individual file  
- error handling (missing file, permission denied, disconnect)  


---

## 7. 🧩 Migration Plan (Step‑by‑Step)

1. **Introduce TransferSession model**  
2. **Refactor TransferManager to accept sessions**  
3. **Add TransferOrchestrator**  
4. **Refactor SftpClient to pure I/O**  
5. **Implement BulkTransferEngine**  
6. **Integrate orchestrator with UI**  
7. **Add notifications**  
8. **Add tests**  
