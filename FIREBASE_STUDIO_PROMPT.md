# Firebase Studio AI Designer Prompt

## Complete App Specification for "ADV Teammate Handbook Acknowledgement System"

---

## PROJECT OVERVIEW

Build a complete **Employee Handbook Acknowledgement System** using **Firebase Hosting** for the frontend (React + Vite + TypeScript + Tailwind CSS) and **Firebase Cloud Functions (Node.js 20)** for the backend. The app has two main views: (1) a **PDF Handbook Reader** with table of contents, search, and supplements, and (2) a **Signing/Acknowledgement page** where employees digitally sign, scan, or print acknowledgement forms. Signed acknowledgements are **saved to Firestore** and can be **printed at remote store printers** via a fax-to-email gateway powered by Power Automate.

The backend code (Cloud Functions) is hosted on GitHub. The frontend is hosted on Firebase Hosting. Firestore is used for data persistence, real-time status tracking, and storing signed acknowledgement records.

---

## TECH STACK

- **Frontend**: React 18+ with Vite, TypeScript, Tailwind CSS 3+
- **Routing**: React Router v6 (5 routes: Home/TOC, Reader, Search, Supplements, Sign)
- **State Management**: React Context or Zustand (lightweight)
- **PDF Rendering**: `react-pdf` (wraps PDF.js) for handbook reader
- **PDF Generation**: `jspdf` for generating signed/blank acknowledgement PDFs
- **Signature Capture**: `react-signature-canvas` or custom canvas component
- **Backend**: Firebase Cloud Functions (Node.js 20, 2nd gen preferred)
- **Database**: Cloud Firestore
- **Hosting**: Firebase Hosting
- **Auth**: None required (public-facing employee tool) but add optional Firebase Auth for admin dashboard later
- **Real-time**: Firestore `onSnapshot` listeners for live print job tracking

---

## FIREBASE PROJECT CONFIGURATION

### Firestore Collections

#### `stores` Collection
```
Document ID: "#005" (store number as string)
Fields:
  storeNumber: string     // "#005"
  location: string        // "Albany"
  faxNumber: string       // "15419243633" (digits only, with country code)
```
~128 store documents. Read: public. Write: admin SDK only.

#### `faxJobs` Collection
```
Document ID: trackingId (e.g., "WEB-20260205125013")
Fields:
  trackingId: string
  status: string          // "Pending" | "Success" | "Failed"
  storeNumber?: string
  faxNumber?: string
  requesterEmail: string
  faxKey?: string
  createdAt: Timestamp
  updatedAt: Timestamp
```
Read: public (frontend listens via onSnapshot). Write: admin SDK only.

#### `fax_log` Collection
```
Document ID: auto-generated
Fields:
  storeNumber: string | null
  location: string
  faxNumber: string
  fileName: string
  type: "blank" | "signed"
  sentAt: Timestamp
  status: string
```
Read/Write: admin SDK only.

#### `signedAcknowledgements` Collection (NEW — save signed forms to Firebase)
```
Document ID: auto-generated
Fields:
  employeeName: string           // "John Doe"
  signDate: string               // "2026-02-06"
  signatureMode: string          // "draw" | "type" | "upload" | "scan"
  signatureDataUrl?: string      // base64 PNG of signature (for draw/type/upload)
  scanImageUrl?: string          // base64 JPEG of scanned document (for scan mode)
  pdfBase64: string              // The full generated PDF as base64
  pdfFileName: string            // "Doe_John_2026_02_06_Acknowledgement.pdf"
  deliveryMethod: string         // "digital" | "print-store" | "print-direct" | "scan"
  storeNumber?: string           // If printed at store
  createdAt: Timestamp
  ipAddress?: string             // Optional, from Cloud Function
  userAgent?: string             // Optional
```
Read: admin only. Write: via Cloud Function (saveAcknowledgement).

### Firestore Security Rules
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /stores/{storeId} {
      allow read: if true;
      allow write: if false;
    }
    match /faxJobs/{jobId} {
      allow read: if true;
      allow write: if false;
    }
    match /fax_log/{logId} {
      allow read, write: if false;
    }
    match /signedAcknowledgements/{docId} {
      allow read: if false;
      allow write: if false; // Cloud Function Admin SDK bypasses
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

---

## CLOUD FUNCTIONS (Node.js 20, Firebase Functions v4+)

All functions use CORS with `origin: true` for cross-origin requests. SMTP config comes from `functions.config()` or `.env`.

### 1. `sendFax` (HTTPS onRequest, POST, 512MB memory)
**Purpose**: Send a PDF to a store's printer via SMTP email to a fax gateway.

**Request body**:
```json
{
  "storeNumber": "#023",
  "pdfBase64": "<base64-encoded-pdf>",
  "fileName": "Blank_Handbook_Acknowledgement.pdf",
  "type": "blank" | "signed"
}
```

**Logic**:
1. Validate required fields
2. Look up store in Firestore `stores` collection by storeNumber
3. Generate tracking ID: `WEB-{YYYYMMDDHHmmss}`
4. Create SMTP email with PDF attachment to fax gateway email
5. Subject format: `{storeNumber} {trackingId}` (Power Automate extracts store number after `#`)
6. In parallel: write to `faxJobs` (status: Pending), send email, write to `fax_log`
7. Return `{ success, message, trackingId, store }`

### 2. `sendFaxDirect` (HTTPS onRequest, POST, 512MB memory)
**Purpose**: Send PDF to a direct fax/printer number (not a store).

**Request body**:
```json
{
  "faxNumber": "15553412222",
  "pdfBase64": "<base64>",
  "fileName": "...",
  "type": "blank" | "signed"
}
```

**Logic**: Same as sendFax but subject format is `Fax#{cleanNumber} {trackingId}`.

### 3. `getStores` (HTTPS onRequest, GET)
**Purpose**: Return all stores ordered by storeNumber. Backup API — frontend embeds store data for instant load.

### 4. `faxWebhook` (HTTPS onRequest, POST)
**Purpose**: Receive instant status updates from Power Automate when fax completes.

**Request body**:
```json
{
  "trackingId": "WEB-20260205125013",
  "status": "Success" | "Failed",
  "faxKey": "20260205-125013"
}
```

**Logic**: Update `faxJobs/{trackingId}` and optionally `faxJobs/{faxKey}` in Firestore. Frontend is listening via `onSnapshot` and gets instant UI update.

### 5. `monitorFaxStatus` (Pub/Sub scheduled, every 30 seconds)
**Purpose**: Fallback — polls Gmail IMAP inbox for `FAXDONE:{faxKey}:{status}` emails from Power Automate.

**Logic**:
1. Connect to Gmail via IMAP (imap-simple library)
2. Search for UNSEEN emails with subject containing "FAXDONE:"
3. Parse subject: `FAXDONE:{faxKey}:{Status}`
4. Parse body for `FAXDATA:{requesterEmail}|{trackingId}:ENDFAXDATA`
5. Update Firestore `faxJobs` documents by both faxKey and trackingId
6. Mark emails as read

### 6. `saveAcknowledgement` (NEW — HTTPS onRequest, POST, 512MB memory)
**Purpose**: Save a signed acknowledgement record to Firestore for permanent storage.

**Request body**:
```json
{
  "employeeName": "John Doe",
  "signDate": "2026-02-06",
  "signatureMode": "draw",
  "signatureDataUrl": "<base64-png>",
  "scanImageUrl": "<base64-jpg-if-scan>",
  "pdfBase64": "<full-pdf-base64>",
  "pdfFileName": "Doe_John_2026_02_06_Acknowledgement.pdf",
  "deliveryMethod": "digital",
  "storeNumber": "#023"
}
```

**Logic**:
1. Validate required fields (employeeName, signDate, pdfBase64, pdfFileName)
2. Write to `signedAcknowledgements` collection with server timestamp
3. Optionally capture IP address and user agent from request headers
4. Return `{ success: true, docId }`

### Environment Variables / Config
```
smtp.host         = SMTP server (e.g., smtp.gmail.com)
smtp.port         = 587
smtp.user         = sender email
smtp.pass         = sender password
smtp.from         = from address
fax.gateway_email = email address Power Automate monitors
gmail.user        = IMAP inbox user (for reading FAXDONE emails)
gmail.pass        = IMAP password (Gmail app password)
```

### Dependencies (package.json)
```json
{
  "dependencies": {
    "cors": "^2.8.5",
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^4.5.0",
    "imap-simple": "^5.1.0",
    "nodemailer": "^6.9.8"
  }
}
```

---

## FRONTEND ARCHITECTURE (React + Vite + TypeScript + Tailwind)

### App Structure
```
src/
├── main.tsx
├── App.tsx                        // Router setup
├── config.ts                      // Firebase config, functions base URL
├── firebase.ts                    // Firebase app + Firestore init
├── hooks/
│   ├── useStores.ts               // Fetch/cache store list
│   ├── useFaxStatus.ts            // Real-time Firestore listener for print jobs
│   └── useSignatureCanvas.ts      // Canvas drawing logic
├── pages/
│   ├── HomePage.tsx               // Table of contents, landing
│   ├── ReaderPage.tsx             // PDF handbook viewer
│   ├── SearchPage.tsx             // Full-text search across handbook
│   ├── SupplementsPage.tsx        // State supplement PDFs
│   └── AcknowledgementPage.tsx    // Main signing page
├── components/
│   ├── layout/
│   │   ├── AppShell.tsx           // Wrapper with toolbar + bottom nav
│   │   ├── TopToolbar.tsx         // Fixed top bar with logo + nav buttons
│   │   ├── BottomNav.tsx          // Fixed bottom tab bar (thumb zone)
│   │   └── HamburgerMenu.tsx      // Slide-out menu panel
│   ├── reader/
│   │   ├── PdfViewer.tsx          // PDF.js canvas renderer
│   │   ├── ZoomControls.tsx       // Zoom in/out/fit
│   │   ├── PageNavigator.tsx      // Page prev/next with swipe
│   │   └── SearchHighlight.tsx    // Text search overlay
│   ├── acknowledgement/
│   │   ├── AckTextSection.tsx     // Legal acknowledgement text card
│   │   ├── SignatureSection.tsx   // Complete signature area
│   │   ├── SignaturePad.tsx       // Canvas drawing (draw mode)
│   │   ├── TypedSignature.tsx     // Typed signature with font picker
│   │   ├── UploadSignature.tsx    // Image file upload for signature
│   │   ├── ScanSignature.tsx      // Camera capture + perspective crop + auto-enhance
│   │   ├── FormFields.tsx         // Name, date inputs
│   │   ├── ConsentCheckbox.tsx    // Legal consent toggle
│   │   ├── SubmitButton.tsx       // Submit with validation
│   │   └── SaveOverlay.tsx        // Post-submit save options modal
│   ├── fax/
│   │   ├── FaxModal.tsx           // Store picker + direct number input
│   │   ├── FaxTriggerCard.tsx     // "Print Blank Form at Store" card
│   │   ├── StoreList.tsx          // Searchable scrollable store list
│   │   └── PrintStatusOverlay.tsx // Floating draggable print status FAB
│   └── toc/
│       ├── TocHeader.tsx          // Hero with logo, title, action buttons
│       ├── TocSearchBar.tsx       // Search input with results
│       └── TocSectionList.tsx     // Collapsible section groups
├── utils/
│   ├── pdfGenerator.ts           // jsPDF generation for signed + blank PDFs
│   ├── printUtils.ts             // Local print, compact text-based print
│   ├── scanUtils.ts              // Homography warp, bilinear sampling, auto-enhance
│   ├── phoneFormat.ts            // Phone number formatting
│   └── api.ts                    // Cloud Function API calls
├── types/
│   └── index.ts                  // TypeScript interfaces
└── assets/
    ├── headliner_logo.png
    └── ro_logo.png
```

### Routes (React Router v6)
```tsx
<Routes>
  <Route path="/" element={<AppShell />}>
    <Route index element={<HomePage />} />
    <Route path="reader" element={<ReaderPage />} />
    <Route path="search" element={<SearchPage />} />
    <Route path="supplements" element={<SupplementsPage />} />
    <Route path="sign" element={<AcknowledgementPage />} />
  </Route>
</Routes>
```

---

## PAGE-BY-PAGE FEATURE SPECIFICATION

### Page 1: Home / Table of Contents (`/`)

**Header**: Full-width gradient banner (navy-950 to navy-900), company logo (headliner_logo.png), title "ADV Teammate Handbook", subtitle "The Retail Odyssey Company", and action buttons: "Read Handbook" (primary blue) and "Sign Acknowledgement" (secondary outlined).

**Search Bar**: Full-width search input that filters TOC entries AND performs full-text search across the handbook PDF. Shows inline results with snippets and highlighted matches.

**Section List**: Collapsible accordion groups. Each group has a numbered badge (blue square), section title (uppercase white), page range, and chevron. Clicking expands to show sub-items with page numbers. Clicking any item navigates to the Reader at that page.

**Sections include** (from the handbook TOC):
- Section 1: Welcome & Introduction (pages 3-5)
- Section 2: Employment Policies (pages 6-12)
- Section 3: Workplace Conduct (pages 13-18)
- Section 4: Compensation & Benefits (pages 19-24)
- Section 5: Time Off & Leave (pages 25-30)
- Section 6: Safety & Security (pages 31-35)
- Section 7: Technology & Communications (pages 36-40)
- Section 8: Acknowledgement (pages 41-42)
(Adjust sections based on actual PDF content)

**Bottom Navigation Bar** (persistent across all pages):
5 tabs: Home, Search, Handbook, Supplements, Sign
- Icons are colorful SVGs (house=red, magnifier=gold, book=green, map=purple, pen=pink)
- Labels always visible (even on mobile)
- Scaled 1.2x for thumb zone accessibility
- Active tab has subtle blue background highlight
- Fixed to bottom with `env(safe-area-inset-bottom)` padding

**Watermark**: Subtle repeating logo pattern overlay at 6% opacity.

### Page 2: Handbook Reader (`/reader`)

**PDF Viewer**: Full-height canvas rendering via PDF.js/react-pdf. The PDF file is `handbook.pdf` loaded from the public assets. Single-page view with swipe navigation (left/right swipe changes pages).

**Top Toolbar** (replaces the standard toolbar on this page):
- Hamburger menu button (fixed top-left, high z-index)
- Company logo (clickable, returns to home)
- Divider
- Spacer
- Zoom controls group: [-] [100%] [+] with fit-to-width toggle
- Page info display (hidden on mobile)
- Navigation buttons: Home, Search, Handbook (active), Supplements, Sign

**Zoom Controls**: Grouped in a pill-shaped container. Zoom range 50%-300%. "Fit" button auto-fits to viewport width. Pinch-to-zoom on mobile.

**Page Navigation**:
- Touch swipe left/right to change pages
- Bottom nav persists
- Remembers last viewed page in localStorage (`handbookLastPage`, `handbookLastView`)

**Search Highlights**: When coming from search, highlight matching text regions with semi-transparent yellow overlays.

**Resources Overlay**: A white card overlay (like a popup) showing a table of important resources (phone numbers, websites, emails). Positioned absolutely over the PDF canvas.

**Text Selection Layer**: Invisible text layer positioned over the PDF canvas for copy-paste support.

### Page 3: Search (`/search`)

Full-text search across the handbook PDF. Input field with search icon. Results show:
- Result title (section name)
- Result meta (page number, uppercase small text)
- Result snippet with `<mark>` highlighted matches
- Clicking navigates to Reader at that page

Visited results show at reduced opacity.

### Page 4: State Supplements (`/supplements`)

Grid/list of state supplement PDFs. Clicking opens the supplement in the Reader view (or separate viewer). Supplements are loaded from known URLs.

### Page 5: Acknowledgement / Sign (`/sign`)

This is the most complex page. It has multiple sections:

#### Section A: Acknowledgement Text Card
Dark card with serif title "Acknowledgement of Receipt" and 5 paragraphs of legal text (the at-will employment acknowledgement). Text is light gray on dark navy background.

Full text paragraphs:
1. "I have received a copy of the Company's Handbook and the applicable Supplement(s)..." (compliance agreement)
2. "I also understand that this Handbook is the most up-to-date version..." (supersedes prior communications)
3. "I acknowledge that my employment relationship with the Company is 'at-will'..." (at-will employment)
4. "I further acknowledge that this handbook and the policies contained herein..." (no contract creation)
5. "By signing below, I acknowledge that I have received and will abide by..." (harassment/discrimination policies)

#### Section B: Sign Below Card

**Printed Name Field**: Text input with label "PRINTED TEAMMATE NAME", placeholder "Enter your full legal name".

**Signature Area** with 4 modes, selectable via toggle buttons:

**Mode Toggle**: 3-column grid of icon buttons (Draw=pencil, Type=keyboard, Upload=arrow-up). A 4th "Scan" mode is triggered from the alternate options section below.

**Draw Mode** (default):
- "Sign Now" button enables the canvas
- Ink color picker: Black (#0f172a) and Blue (#1d4ed8) circles
- Pen size slider (range 1-6, step 0.5, default 2)
- Canvas: 100% width, 170px height, crosshair cursor
- Drawing uses mouse/touch events with `touch-action: none`
- Baseline guide line near bottom
- Placeholder text: "Sign here using your mouse or finger"
- "Save" and "Clear" buttons appear when signature exists
- Orientation hint: "Tip: rotate your device for more signing space" (shown on portrait mobile)
- Canvas preserves signature on resize via dataURL save/restore
- `overscroll-behavior: none` prevents pull-to-refresh interference

**Type Mode**:
- Text input for typing name
- Font selector dropdown: Dancing Script, Great Vibes, Pacifico (Google Fonts, cursive)
- "Apply Signature" button renders typed text onto canvas with auto-sizing
- Preview renders at up to 64px font size, shrinks to fit canvas width

**Upload Mode**:
- "Choose Image" button opens file picker (accept="image/*")
- Selected image is drawn centered/scaled-to-fit on the signature canvas
- Supports PNG, JPG (transparent backgrounds work best)

**Scan Mode** (accessible from "Alternate Options" section):
- "Capture Photo" button opens camera (uses `<input type="file" accept="image/*" capture="environment">`)
- Photo appears on a dedicated scan canvas (100% width, 320px height, dark background)
- **4 draggable corner handles** for perspective crop (pointer events)
- Crop polygon drawn as blue outline over the image
- "Auto Enhance" button applies contrast (1.15x) and brightness (+12) adjustment
- "Apply Crop" button performs **perspective warp** (homography transform with bilinear sampling) to straighten the cropped region
- "Retake" button resets scan
- The warped output is saved as JPEG at 92% quality
- **Full homography implementation**: 8-parameter perspective transform matrix, Gaussian elimination solver, bilinear pixel interpolation

**Date Field**: Date input, auto-filled with today's date.

**Consent Checkbox**: Styled checkbox with legal consent text that changes based on signature mode:
- Draw/Type/Upload: "By checking this box, I agree that my digital signature...is the legal equivalent of my handwritten signature. I confirm I have reviewed the ADV Teammate Handbook and my State Supplement..."
- Scan: "By checking this box, I confirm the scanned document is my signed acknowledgement..."

**Submit Button**: Full-width blue gradient button "Submit Acknowledgement". Disabled until: name filled, signature/scan provided, date set, consent checked. Haptic vibration on submit (navigator.vibrate).

#### Section C: Post-Submit Save Overlay (Modal)

Full-screen overlay with success card showing:
- Green checkmark icon in circle
- "Acknowledgement Signed" title
- Signer details: Name, Date, Delivery method, Filename
- **Save buttons** (vertical stack):
  1. "Save to OneDrive" (blue OneDrive branded button — uses OneDrive JS SDK file picker)
  2. "Download PDF to Device" (outlined button — triggers jsPDF `.save()`)
  3. "Print on This Device" (outlined button — opens PDF in new window/iframe and triggers print dialog)
  4. "Print Signed Copy at Store" (outlined button — opens Fax Modal in 'signed' mode)
  5. "Close" button

**CRITICAL NEW FEATURE**: After submit, also call the `saveAcknowledgement` Cloud Function to persist the signed form to Firestore. This happens automatically in the background when the user submits.

#### Section D: Fax/Print Trigger Card
Below the sign form: "Print Blank Form at Your Store" card with printer icon, description text, and arrow. Clicking opens the Fax Modal in 'blank' mode.

#### Section E: Alternate Options
Collapsible "Scan Signed Document" card that triggers scan mode.

---

## FAX/PRINT MODAL (`FaxModal.tsx`)

A modal (centered on desktop, bottom sheet on mobile ≤640px) with:

**Header**: Title changes based on mode ("Print Blank Form" vs "Print Signed Copy"), subtitle describes the action. Close X button. On mobile, a drag handle bar at top.

**Store Search**: Search input with magnifying glass icon. Filters store list by store number or city name.

**Store List**: Scrollable list (max-height 300px, 35vh on mobile) of radio-button items. Each shows:
- Radio circle (fills blue when selected)
- Store number (bold white) + location (gray subtitle)
- Green checkmark (appears when selected)
Clicking selects a store and clears the direct number input.

**Divider**: "Or enter printer number" centered between horizontal lines.

**Direct Number Input**: tel input for entering any fax/printer number. Typing clears store selection.

**Send Button**: Full-width "Send to Printer" button with paper plane icon. Disabled until a store is selected or valid number entered (≥10 digits). Shows spinner while sending.

**Status Area**: Below the button, shows status messages:
- `.sending` — blue pulsing background
- `.waiting` — amber pulsing background with timer
- `.success` — green background
- `.error` — red background
- `.delivered` — brighter green
- `.info` — info blue

**Mobile Bottom Sheet**: On screens ≤640px, the modal slides up from bottom with rounded top corners (20px), max-height 90vh, safe area padding on footer.

---

## FLOATING PRINT STATUS OVERLAY (`PrintStatusOverlay.tsx`)

A floating card (340px wide, 300px on mobile) anchored to bottom-right above the bottom nav. Features:

**Minimized State**: 56px circle FAB with printer icon. Status-colored icon animations:
- Sending: spinning
- Waiting: pulsing
- Delivered: solid green checkmark
- Error: solid red

Notification dot (green pulsing circle) appears when status changes while minimized.

**Expanded State**: Card with:
- Draggable header (grab cursor, constrained to viewport)
- Minimize (dash) and Close (X) buttons
- Status icon (32px square, colored background matching state)
- Status title + subtitle text
- Elapsed timer display

**State transitions**:
1. `sending` → spinner icon, blue, "Sending to print server..."
2. `waiting` → clock icon, amber, "Waiting for print confirmation..."
3. `delivered` → checkmark icon, green glow border, "Printed Successfully"
4. `error` → exclamation icon, red glow border, "Print Failed"

**Behaviors**:
- Auto-expands from minimized when status changes
- Vibration on completion (`navigator.vibrate`)
- Auto-dismiss after 30 seconds on success
- Drag uses pointer events, snaps to viewport edges

---

## PDF GENERATION (jsPDF)

### Signed PDF (`generateSignedPDF`)
Letter size (215.9mm × 279.4mm), portrait.

**Layout**:
1. Navy banner header (30mm): "ADV Teammate Handbook" in white bold 16pt, subtitle "Acknowledgement of Receipt | Revised February 2026" in gray 10pt, company logo right-aligned
2. Section title "Acknowledgement of Receipt" with blue underline
3. Five legal paragraphs in 9.5pt gray
4. Consent checkbox area: light gray rounded rect with checked box and italic consent text
5. Printed name with underline and label
6. Two-column: Signature image (left) + Date text (right), both with underlines and labels
7. Footer: copyright + page number

**Scan mode variant**: Minimal 18mm banner, scan image fills the page, footer note "Scan submitted via camera".

### Blank PDF (`generateBlankPDF`)
Same letter format but condensed:
1. Smaller 26mm navy banner with logo
2. **Condensed single-paragraph** acknowledgement text (8.5pt) — combines all 5 paragraphs into one brief summary
3. Consent checkbox area
4. Blank signature lines (just the lines and labels, no filled-in content)
5. Minimal headers for **compact printing** — uses less ink and paper
6. Footer: "Blank Form for Manual Signing"

### Print-Optimized Text Version (NEW)
When printing locally, generate a **text-heavy version with minimal headers**:
- Remove the navy banner entirely, use simple black text header
- Reduce all margins
- Use standard serif font for body text
- Minimal graphics (just lines for signatures)
- No background colors or gradient elements
- Optimized to fit on a single page when possible

---

## MOBILE-FIRST DESIGN REQUIREMENTS

### Thumb Zone Optimization
- **Bottom navigation bar**: 5 tabs, scaled 1.2x (`--bottom-nav-scale: 1.2`), always visible labels
- **All interactive elements**: minimum 44px touch target (48px on small screens)
- **Signature colors**: 34px circles (38px on mobile)
- **Store list items**: minimum 52px height
- **Submit button**: minimum 52px height
- **Form inputs**: minimum 48px height (52px on mobile), 16px font to prevent iOS zoom

### Responsive Breakpoints
- **≤380px**: Extra compact layout, stacked cards, reduced padding
- **≤540px**: Single-column form grid
- **≤640px**: Bottom sheet modals, hidden toolbar button labels, compact headers
- **>640px**: Centered modals, visible labels, wider padding

### Mobile UX Features
- `touch-action: manipulation` on all interactive elements
- `-webkit-appearance: none` on inputs
- `overscroll-behavior: none` on signature canvas
- `viewport-fit=cover` for safe area support
- `scroll-padding-bottom` for input focus scroll
- Haptic feedback via `navigator.vibrate` on submit and errors
- Pull-to-refresh prevention on drawing surfaces

---

## DESIGN SYSTEM (Tailwind + CSS Variables)

### Color Palette
```css
--navy-950: #060e1a    /* Deepest background */
--navy-900: #0d1b2a    /* Primary card background */
--navy-800: #1b2d4a    /* Elevated surfaces */
--navy-700: #243b5e
--navy-600: #2e4a72
--blue-500: #4a90c4    /* Primary brand / interactive */
--blue-400: #6aaddb    /* Hover state */
--blue-300: #7cb9d8
--blue-200: #a3d5e8
--blue-100: #d4ecf5
--blue-50:  #eef7fb
--slate-50 through --slate-900  /* Standard Tailwind slate */
--white:    #ffffff
--red-500:  #ef4444    /* Errors */
--green-500: #22c55e   /* Success */
--amber-500: #f59e0b   /* Warning/waiting */
```

### Typography
- **Primary**: 'Plus Jakarta Sans' (weights: 300-800)
- **Serif headings**: 'DM Serif Display' (weight: 400)
- **Signature fonts**: 'Dancing Script', 'Great Vibes', 'Pacifico' (cursive)
- **Base line-height**: 1.6

### Card Style
- Background: var(--navy-900)
- Border: 1px solid rgba(74,144,196,0.12)
- Border-radius: 14px (12px on mobile)
- Padding: 2rem 1.75rem (1.5rem 1.15rem on mobile)
- Box-shadow: 0 2px 12px rgba(0,0,0,0.15)
- Hover: increased border opacity + deeper shadow

### Gradient Header
```css
background: linear-gradient(135deg, var(--navy-950) 0%, var(--navy-900) 50%, var(--navy-800) 100%);
```
With decorative radial gradient "orb" pseudo-elements.

### Animations
- `fadeIn`: opacity 0→1
- `slideUp`: opacity 0→1, translateY 20px→0
- `slideUpSheet`: translateY 100%→0 (bottom sheet)
- `shakeError`: horizontal shake for validation errors
- `spin`: 360° rotation for loading spinners
- `pulse-sending`: opacity 1→0.7→1 for waiting states
- `notifyPulse`: scale + box-shadow pulse for notification dot
- `floatOverlayIn/Out`: scale 0.92→1 + translateY for overlay entrance

---

## EMBEDDED STORE DATA

The frontend embeds all store data for instant load (no API call needed on page load). The `getStores` Cloud Function serves as a backup API.

Store data format (128 stores):
```typescript
interface Store {
  n: string;  // Store number, e.g., "#005"
  l: string;  // Location name, e.g., "Albany"
  f: string;  // Fax number, digits only with country code
}
```

Include all 128 stores in the embedded data constant (from Retail Odyssey / Fred Meyer / Kroger stores across Oregon, Washington, Idaho, Alaska). Store numbers range from #005 to #999.

---

## API SERVICE LAYER (`src/utils/api.ts`)

```typescript
const FUNCTIONS_BASE = import.meta.env.VITE_FUNCTIONS_BASE || '';

export async function sendFaxToStore(storeNumber: string, pdfBase64: string, fileName: string, type: 'blank' | 'signed') {
  const res = await fetch(`${FUNCTIONS_BASE}/sendFax`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storeNumber, pdfBase64, fileName, type })
  });
  return res.json();
}

export async function sendFaxDirect(faxNumber: string, pdfBase64: string, fileName: string, type: 'blank' | 'signed') {
  const res = await fetch(`${FUNCTIONS_BASE}/sendFaxDirect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ faxNumber, pdfBase64, fileName, type })
  });
  return res.json();
}

export async function saveAcknowledgement(data: SignedAcknowledgement) {
  const res = await fetch(`${FUNCTIONS_BASE}/saveAcknowledgement`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.json();
}

export async function fetchStores() {
  const res = await fetch(`${FUNCTIONS_BASE}/getStores`);
  return res.json();
}
```

---

## REAL-TIME FAX STATUS TRACKING

```typescript
// useFaxStatus.ts hook
import { onSnapshot, doc } from 'firebase/firestore';

export function useFaxStatus(trackingId: string | null) {
  // Subscribe to faxJobs/{trackingId} document
  // Return { status, faxKey, updatedAt }
  // Cleanup listener on unmount or trackingId change
  // Status values: "Pending" | "Success" | "Failed"
  // Timeout after 5 minutes shows "still processing" hint
}
```

The frontend subscribes via `onSnapshot` immediately after `sendFax` returns a trackingId. The Cloud Function (`monitorFaxStatus` or `faxWebhook`) updates the Firestore document, and the frontend receives the update in real-time.

---

## PRINT FUNCTIONALITY (CRITICAL)

### 1. Print Blank at Store
- Opens FaxModal in `blank` mode
- Generates a compact blank PDF with condensed text and empty signature lines
- Sends via Cloud Function to store printer
- Tracks delivery in real-time

### 2. Print Signed at Store
- Opens FaxModal in `signed` mode (from save overlay)
- Uses the already-generated signed PDF
- Same Cloud Function flow

### 3. Print on This Device
- Opens the generated PDF blob URL in a new window
- Calls `window.print()` on load
- Fallback: hidden iframe with print trigger

### 4. Compact Text Print (NEW)
- When printing locally, offer a "Print Compact Version" option
- Generates a text-only version with:
  - No navy banner or colored backgrounds
  - Simple "ADV Teammate Handbook — Acknowledgement of Receipt" header in black
  - Body text in 9pt serif font
  - Signature and date on single line where possible
  - Minimal margins (15mm)
  - No logo watermarks
  - Goal: fit everything on ONE page for minimal paper/ink usage

---

## SCAN WORKFLOW (DETAILED)

The scan feature allows users to photograph a physically-signed acknowledgement form and submit it digitally.

### Steps:
1. User clicks "Scan Signed Document" → sets signature mode to `scan`
2. "Capture Photo" button triggers `<input type="file" accept="image/*" capture="environment">`
3. Photo loads onto scan canvas (320px height, dark background)
4. Auto-enhance is applied by default (contrast 1.15x, brightness +12)
5. 4 draggable corner handles appear over the image at default positions (8%/12% inset from edges)
6. User drags handles to mark the document corners
7. Blue polygon outline shows the crop boundary
8. "Apply Crop" performs perspective correction:
   - Maps the 4 user-selected points to a rectangular output
   - Uses homography matrix computation (8-parameter, Gaussian elimination)
   - Bilinear interpolation for smooth pixel sampling
   - Output dimensions match the maximum span of selected corners
9. Cropped image saved as JPEG (92% quality)
10. PDF generation wraps the scan image in a minimal header PDF

### Homography Math (preserve this logic):
```typescript
function computeHomography(src: Point[], dst: Point[]): number[] {
  // Build 8x8 linear system from 4 point correspondences
  // Solve via Gaussian elimination with partial pivoting
  // Return [h0..h7] parameters
}

function warpImage(image: HTMLImageElement, srcPts: Point[], outW: number, outH: number, enhance: boolean): HTMLCanvasElement {
  // For each output pixel, compute source coordinate via homography
  // Sample using bilinear interpolation
  // Optionally apply contrast/brightness enhancement
}
```

---

## SAVING SIGNED ACKNOWLEDGEMENTS TO FIREBASE (NEW FEATURE)

After the user submits the form:
1. Generate the PDF as before
2. Show the save overlay
3. **In the background**, call `saveAcknowledgement` Cloud Function with:
   - Employee name and sign date
   - Signature mode and data
   - Full PDF as base64
   - Delivery method
4. Store in `signedAcknowledgements` Firestore collection
5. Show a subtle toast/indicator that the record was saved to the cloud
6. If the save fails, show a warning but don't block the user from downloading

This ensures every signed acknowledgement is permanently recorded in Firebase regardless of whether the user downloads, prints, or closes the page.

---

## KEY UI/UX PATTERNS TO MAINTAIN

1. **Dark theme throughout** — navy backgrounds, light text, blue accents
2. **Glass morphism** — backdrop-filter blur on overlays and nav bars
3. **Smooth transitions** — 0.15s-0.3s ease for all interactive states
4. **Active press feedback** — `transform: scale(0.97)` on button press
5. **Error shake animation** — horizontal shake on validation errors with red highlights
6. **Safe area padding** — `env(safe-area-inset-*)` on all fixed elements
7. **Keyboard shortcuts** — Escape to close modals
8. **Loading states** — Skeleton screens or spinner overlays
9. **Demo mode** — When `FUNCTIONS_BASE` is empty, show info messages instead of making API calls
10. **Scrollbar styling** — Thin 6px custom scrollbar matching theme
11. **Watermark overlay** — Repeating company logo at 6% opacity behind content

---

## ENVIRONMENT VARIABLES (.env)

```
VITE_FIREBASE_API_KEY=your-api-key
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FUNCTIONS_BASE=https://us-central1-YOUR-PROJECT.cloudfunctions.net
VITE_ONEDRIVE_CLIENT_ID=your-azure-ad-client-id
```

---

## DEPLOYMENT

### Firebase Hosting (Frontend)
```json
// firebase.json
{
  "hosting": {
    "public": "dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [
      { "source": "**", "destination": "/index.html" }
    ]
  },
  "functions": {
    "source": "functions",
    "runtime": "nodejs20"
  },
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  }
}
```

### Build & Deploy
```bash
npm run build          # Vite build → dist/
firebase deploy        # Deploy hosting + functions + rules
```

---

## SUMMARY OF ALL FEATURES (CHECKLIST)

### Handbook Reader
- [ ] PDF rendering with zoom controls (50%-300%)
- [ ] Page navigation (swipe + buttons)
- [ ] Full-text search with highlighted results
- [ ] Table of contents with collapsible sections
- [ ] State supplements viewer
- [ ] Remember last viewed page (localStorage)
- [ ] Text selection layer for copy-paste

### Acknowledgement Signing
- [ ] Draw signature (canvas with pen size/color options)
- [ ] Type signature (3 cursive font choices)
- [ ] Upload signature image (PNG/JPG)
- [ ] Camera scan with perspective crop + auto-enhance
- [ ] Form validation with error shake animations
- [ ] Consent checkbox with context-aware text
- [ ] PDF generation (signed, blank, scan, compact text)
- [ ] **Save to Firestore** on submit (NEW)

### Print/Fax System
- [ ] Print blank form at store (fax modal → Cloud Function → SMTP → fax gateway)
- [ ] Print signed copy at store (same flow)
- [ ] Print on this device (browser print dialog)
- [ ] Compact text-only print version (NEW — minimal headers)
- [ ] Searchable store picker (128 stores)
- [ ] Direct fax number input
- [ ] Real-time delivery tracking (Firestore onSnapshot)
- [ ] Floating draggable status overlay with FAB minimize

### Save Options
- [ ] Download PDF to device
- [ ] Save to OneDrive (JS SDK)
- [ ] Local print
- [ ] Store print
- [ ] Auto-save to Firestore (NEW)

### Navigation & UX
- [ ] 5-tab bottom navigation bar (thumb zone optimized)
- [ ] Hamburger menu with quick links
- [ ] Top toolbar with logo and action buttons
- [ ] Responsive design (380px → desktop)
- [ ] Dark theme with navy/blue palette
- [ ] Haptic feedback on mobile
- [ ] Safe area support for notched devices
- [ ] Demo mode when backend not configured
