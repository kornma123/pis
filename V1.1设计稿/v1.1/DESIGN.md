# Design System: COREONE Pathology Lab Inventory Management

## 1. Visual Theme & Atmosphere

COREONE is a pathology laboratory consumables management system — a data-dense, operation-critical enterprise application. The design language draws inspiration from modern SaaS products like Linear, Notion, and Figma: refined minimalism with subtle warmth, soft depth, and intentional polish.

This is medical-grade software that prioritizes clarity and efficiency, but with a contemporary, approachable aesthetic. The interface feels alive — gentle shadows create depth, soft rounded corners invite interaction, and a carefully curated color palette balances professionalism with warmth.

The Inter type family serves as the system's backbone — the modern standard for web applications. At display sizes, Inter's clean letterforms convey confidence without heaviness. At body sizes, carefully tuned weights and spacing ensure exceptional readability during long operational sessions.

What defines this system is its refined minimalism. Cards float with subtle shadows on a soft gray canvas. Buttons feature gentle 6px border-radius — friendly but not playful. Form inputs use fully rounded containers with focus rings that glow softly. The overall effect is professional precision with human warmth.

**Key Characteristics:**
- Inter font family — modern, highly legible, designed for screens
- Refined border-radius: 6px (buttons/inputs), 8px (cards), 12px (modals), 24px (pills)
- Subtle shadows: layered elevation system from 0px to 24px blur
- Soft color palette: warm grays, gentle accents, semantic colors with reduced saturation
- 4px spacing grid — precise but flexible
- Depth through shadow layering, not just background colors
- Focus states with soft glow rings (box-shadow, not outline)
- Smooth transitions: 150ms ease for interactions

## 2. Color Palette & Roles

### Primary
- **Primary Blue** (`#3b82f6`): The main interactive color. Primary buttons, links, active states.
- **Primary Blue Hover** (`#2563eb`): Hover state for primary elements.
- **Primary Blue Active** (`#1d4ed8`): Active/pressed state.
- **Primary Blue Light** (`#eff6ff`): Light tint backgrounds, selected states.

- **Pure White** (`#ffffff`): Page background, card surfaces.
- **Near Black** (`#111827`): Primary text, headings.

### Neutral Scale (Warm Gray Family)
- **Gray 900** (`#111827`): Primary text, headings.
- **Gray 800** (`#1f2937`): Secondary headings, strong emphasis.
- **Gray 700** (`#374151`): Body text, important content.
- **Gray 600** (`#4b5563`): Secondary text, descriptions.
- **Gray 500** (`#6b7280`): Muted text, placeholders, timestamps.
- **Gray 400** (`#9ca3af`): Disabled text, borders.
- **Gray 300** (`#d1d5db`): Borders, divider lines.
- **Gray 200** (`#e5e7eb`): Light borders, card outlines.
- **Gray 100** (`#f3f4f6`): Secondary surface background, alternating rows.
- **Gray 50** (`#f9fafb`): Page background, subtle fills.

### Semantic Status
- **Green 500** (`#22c55e`): Success, normal status.
- **Green 50** (`#f0fdf4`): Success background.
- **Yellow 500** (`#eab308`): Warning, approaching expiry.
- **Yellow 50** (`#fefce8`): Warning background.
- **Orange 500** (`#f97316`): Danger, near expiry.
- **Orange 50** (`#fff7ed`): Danger background.
- **Red 500** (`#ef4444`): Critical, expired, errors.
- **Red 50** (`#fef2f2`): Critical background.

## 3. Typography Rules

### Font Family
- **Primary**: `Inter`, with fallbacks: `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
- **Monospace**: `JetBrains Mono`, with fallbacks: `"JetBrains Mono", "Fira Code", Consolas, monospace`

### Hierarchy

| Role | Font | Size | Weight | Line Height | Letter Spacing |
|------|------|------|--------|-------------|----------------|
| Page Title | Inter | 28px | 600 | 1.25 | -0.02em |
| Section Title | Inter | 22px | 600 | 1.3 | -0.01em |
| Card Title | Inter | 16px | 600 | 1.4 | 0 |
| Body | Inter | 14px | 400 | 1.5 | 0 |
| Body Emphasis | Inter | 14px | 500 | 1.5 | 0 |
| Caption | Inter | 12px | 400 | 1.4 | 0.01em |
| Table Header | Inter | 12px | 500 | 1.4 | 0.02em |
| Button | Inter | 14px | 500 | 1 | 0 |
| Code | JetBrains Mono | 13px | 400 | 1.5 | 0 |

## 4. Component Stylings

### Buttons

**Primary Button**
- Background: `#3b82f6`
- Text: `#ffffff`
- Padding: 10px 16px
- Border-radius: 6px
- Height: 40px
- Box-shadow: `0 1px 2px rgba(59, 130, 246, 0.1)`
- Hover: `#2563eb`
- Focus: `0 0 0 3px rgba(59, 130, 246, 0.3)`

**Secondary Button**
- Background: `#ffffff`
- Text: `#374151`
- Border: 1px solid `#d1d5db`
- Border-radius: 6px
- Hover: background `#f9fafb`

**Danger Button**
- Background: `#ef4444`
- Text: `#ffffff`
- Hover: `#dc2626`

### Cards
- Background: `#ffffff`
- Border-radius: 8px
- Box-shadow: `0 1px 3px rgba(0, 0, 0, 0.1)`
- Padding: 20px

### Tables
- Header background: `#f9fafb`
- Header text: `#374151`, 12px, weight 500
- Row hover: `#f9fafb`
- Border: 1px solid `#e5e7eb`
- Cell padding: 12px 16px

### Status Tags
| Status | Background | Text |
|--------|-----------|------|
| Normal | `#f0fdf4` | `#22c55e` |
| Warning | `#fefce8` | `#ca8a04` |
| Danger | `#fff7ed` | `#ea580c` |
| Critical | `#fef2f2` | `#dc2626` |

- Border-radius: 24px (pill)
- Padding: 4px 12px
- Font-size: 12px

### Inputs
- Background: `#ffffff`
- Border: 1px solid `#d1d5db`
- Border-radius: 6px
- Height: 40px
- Padding: 0 12px
- Focus: border `#3b82f6`, box-shadow `0 0 0 3px rgba(59, 130, 246, 0.1)`

### Navigation
- Background: `#ffffff`
- Border-right: 1px solid `#e5e7eb`
- Active item: background `#eff6ff`, text `#3b82f6`

## 5. Layout Principles

### Spacing System
- Base unit: 4px
- Common values: 4px, 8px, 12px, 16px, 20px, 24px, 32px

### Page Layout
- Sidebar: 256px width
- Content padding: 24px
- Card gap: 16px

### Shadow System
| Level | Shadow |
|-------|--------|
| sm | `0 1px 2px rgba(0,0,0,0.05)` |
| md | `0 4px 6px rgba(0,0,0,0.07)` |
| lg | `0 10px 15px rgba(0,0,0,0.1)` |
| xl | `0 20px 25px rgba(0,0,0,0.1)` |

## 6. Do's and Don'ts

### Do
- Use Inter font family throughout
- Apply 6px border-radius to buttons and inputs
- Use 8px border-radius for cards
- Use subtle shadows for depth
- Apply focus glow rings with box-shadow
- Use 150ms ease transitions
- Use warm gray palette

### Don't
- Use 0px border-radius (too harsh)
- Use pure black for text
- Use fully saturated colors
- Use heavy drop shadows
- Use outline for focus states

## 7. Agent Prompt Guide

### Quick Color Reference
- Primary: `#3b82f6`
- Background: `#f9fafb`
- Card: `#ffffff`
- Text: `#111827`
- Secondary text: `#6b7280`
- Border: `#e5e7eb`

### Example Component Prompts
- "Create a primary button: bg #3b82f6, text white, rounded-md (6px), shadow-sm, hover:bg #2563eb"
- "Design a card: bg white, rounded-lg (8px), shadow-md, p-5"
- "Build a form input: border border-gray-300, rounded-md, focus:ring-2 focus:ring-blue-500"
- "Create a status tag: rounded-full, px-3 py-1, text-sm"

### Key Changes from IBM Carbon
| Element | IBM Carbon | Modern Style |
|---------|-----------|--------------|
| Border-radius | 0px | 6px-8px |
| Font | IBM Plex Sans | Inter |
| Shadows | None / flat | Subtle layered |
| Focus | Outline | Glow ring |
| Colors | Clinical blue | Warm blue #3b82f6 |
| Inputs | Bottom border only | Full border rounded |