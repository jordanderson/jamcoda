# JamCoda Style Guide

## Overview

JamCoda uses a minimalist black/white/gray design. Color is reserved for data visualization, status indicators, and a single accent used for focus and links. This keeps the data clearly visible.

## Color Palette

### Primary Theme: Neutrals Only
- **Background**: White (`bg-white`)
- **Text**:
  - Primary: `text-gray-900` (headings, important text)
  - Body: `text-gray-600` (regular text)
  - Secondary: `text-gray-500` (less prominent text)
  - Muted: `text-gray-400` (icons, dividers)
- **Borders**: `border-gray-200`, `border-gray-300`
- **Backgrounds**:
  - Cards: `bg-white`
  - Hover: `hover:bg-gray-50`, `hover:bg-gray-100`
  - Active/Selected: `bg-gray-900 text-white`
  - Sidebar: `bg-gray-900`

### Accent Color

A single accent pair is used for focus rings, inline links, and piano roll notes:
- **Accent**: `#9198E5` (`focus:ring-[#9198E5]`, `text-[#9198E5]`)
- **Accent hover**: `#E66465` (`hover:text-[#E66465]`)

These are arbitrary Tailwind values, not theme colors — see Implementation Notes.

### Color Exceptions (Data Visualization)

Beyond the accent, color is used for data visualization and status indicators:

#### 1. Progress Bars
Color-coded by completion percentage:
- **Green** (≥80%): `bg-green-500`
- **Yellow** (50-79%): `bg-yellow-500`
- **Orange** (<50%): `bg-orange-500`
- Background: `bg-gray-200`

#### 2. Annotation Pills
- Each pill represents a single annotation (song + start time)
- Format: "Song Name MM:SS"
- Dynamic colors generated from song name hash
- Uses HSL: `hsl(hash % 360, 70%, 85%)` for background
- Text color: `hsl(hash % 360, 70%, 35%)`
- Same song appears multiple times if practiced multiple times in session
- Clickable to jump directly to that specific annotation's start time
- Hover effect: `hover:opacity-80` for interactivity feedback

```jsx
<button
  onClick={(e) => {
    e.stopPropagation()
    onFileSelect(file.id, annotation.start_time)
  }}
  className="inline-block px-2 py-1 text-xs rounded-full font-medium hover:opacity-80 transition-opacity cursor-pointer"
  style={{
    backgroundColor: stringToColor(annotation.song_name),
    color: stringToTextColor(annotation.song_name)
  }}
  title={`Jump to ${annotation.song_name} at ${formatTime(annotation.start_time)}`}
>
  {annotation.song_name} {formatTime(annotation.start_time)}
</button>
```

**Example:** If you practiced "Song A" at 0:34, then "Song B" at 12:02, then "Song A" again at 22:43, you'll see three pills: "Song A 0:34", "Song B 12:02", and "Song A 22:43". Both "Song A" pills share a color because the color is derived from the song name.

#### 3. Piano Roll Visualization
- **MIDI Notes**: `rgb(148, 152, 229)` (blue-purple)
- **Active Notes**: `rgb(230, 100, 101)` (red)
- **Playback Cursor**: Red vertical line with shadow
- **Checkpoint Markers**:
  - Start: Green (`bg-green-500`)
  - End: Red (`bg-red-500`)
- **Annotation Overlays**: Dynamic colors (song name hash), 30% opacity

#### 4. Status Indicators
- **Success**: `text-green-600` / `bg-green-50`
- **Error**: `text-red-600` / `bg-red-50`
- **Playing**: Green pulse dot

## Typography

- **Page Titles**: `text-3xl font-bold text-gray-900`
- **Section Headings**: `text-xl font-bold text-gray-900`
- **Subsection Headings**: `text-lg font-bold text-gray-900`
- **Body Text**: `text-gray-600`
- **Secondary Text**: `text-sm text-gray-500`
- **Labels**: `text-sm font-medium text-gray-700`
- **Muted Text**: `text-xs text-gray-500`

## Icons

All icons use **Lucide React** (installed via `lucide-react` npm package).

### Icon Usage
```jsx
import { IconName } from 'lucide-react'

<IconName className="w-5 h-5 text-gray-600" />
```

### Common Icons
| Purpose | Icon Component | Usage |
|---------|---------------|-------|
| Library/Files | `Library` | Navigation, file browsing |
| Sync | `RefreshCw` | Sync button, syncing animation |
| Play | `Play` | Start playback |
| Pause | `Pause` | Pause playback |
| Stop | `Square` | Stop playback |
| Add | `Plus` | Create new items |
| Edit | `Pencil` | Edit annotations |
| Delete | `Trash2` | Delete annotations |
| Navigation | `Navigation` | Follow/snap mode |
| Arrow | `ChevronRight` | List navigation |
| Success | `CheckCircle` | Success messages |
| Error | `XCircle` | Error messages |
| Warning | `AlertCircle` | Warning messages |
| Music | `Music` | Songs navigation |
| Flag/Checkpoint | `Flag` | Mark start/end checkpoints |
| Close/Clear | `X` | Clear selections, close dialogs |
| Review queue | `ClipboardCheck` | Prediction review navigation |
| Sort ascending | `ArrowUp` | Sortable table headers |
| Sort descending | `ArrowDown` | Sortable table headers |
| ML actions | `Sparkles` | Run predictions, rebuild model |

### Icon Sizing
- Small: `w-4 h-4` (16px)
- Medium: `w-5 h-5` (20px)
- Large: `w-6 h-6` (24px)

## Components

### Cards
```jsx
<div className="border border-gray-200 rounded-lg shadow-sm bg-white">
  <div className="p-6">
    {/* content */}
  </div>
</div>
```

### Buttons

#### Primary Button
```jsx
<button className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors">
  Action
</button>
```

#### Secondary Button
```jsx
<button className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors">
  Action
</button>
```

#### Danger Button
```jsx
<button className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors">
  Delete
</button>
```

#### Icon Button
```jsx
<button className="text-gray-600 hover:text-gray-900 transition-colors" title="Action">
  <IconName className="w-5 h-5" />
</button>
```

#### Status Buttons (Checkpoints)
```jsx
{/* Success/Start Action */}
<button className="px-3 py-1.5 bg-green-500 hover:bg-green-600 disabled:bg-green-300 text-white rounded text-sm font-medium transition-colors flex items-center gap-1.5">
  <Flag className="w-3.5 h-3.5" />
  Start
</button>

{/* Warning/End Action */}
<button className="px-3 py-1.5 bg-red-500 hover:bg-red-600 disabled:bg-red-300 text-white rounded text-sm font-medium transition-colors flex items-center gap-1.5">
  <Flag className="w-3.5 h-3.5" />
  End
</button>
```

### Headers

#### Page Header
```jsx
<div className="mb-6">
  <h1 className="text-3xl font-bold text-gray-900">Page Title</h1>
  <p className="text-gray-600 mt-2">Subtitle or description</p>
</div>
```

#### Card Header
```jsx
<div className="bg-white p-6 border-b border-gray-200">
  <h2 className="text-xl font-bold text-gray-900">Section Title</h2>
  <p className="text-gray-600 mt-1">Description</p>
</div>
```

### Loading States
```jsx
<div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 mx-auto"></div>
```

### Error States
```jsx
<div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-2">
  <AlertCircle className="w-5 h-5 text-red-700 flex-shrink-0" />
  <p className="text-red-700">Error message</p>
</div>
```

### Success States
```jsx
<div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-2">
  <CheckCircle className="w-5 h-5 text-green-700 flex-shrink-0" />
  <p className="text-green-700">Success message</p>
</div>
```

### Keyboard Shortcuts Display
```jsx
<div className="text-xs text-gray-500">
  Press <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-700 font-mono">S</kbd> to start
</div>
```

Multiple shortcuts:
```jsx
<div className="text-xs text-gray-500">
  <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-700 font-mono">S</kbd> start ·
  <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-700 font-mono">E</kbd> end ·
  <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-700 font-mono">C</kbd> clear
</div>
```

## Layout

### Sidebar
- Dark background: `bg-gray-900`
- Light text: `text-white`, `text-gray-300`
- Active nav item: `bg-gray-800 text-white`
- Borders: `border-gray-800`

### Main Content
- Background: `bg-gray-100` on the app shell (subtle contrast to white cards)
- Padding: `p-8` or `p-6`
- Centered with `container mx-auto`

### Tables
```jsx
<table className="w-full">
  <thead className="bg-gray-50 border-b">
    <tr>
      <th className="text-left py-3 px-4 font-semibold text-gray-700 text-sm">
        Header
      </th>
    </tr>
  </thead>
  <tbody className="divide-y">
    <tr className="hover:bg-gray-50 cursor-pointer transition-colors">
      <td className="py-3 px-4 text-sm text-gray-600">
        Cell content
      </td>
    </tr>
  </tbody>
</table>
```

## Implementation Notes

### Tailwind Config
`tailwind.config.js` defines no custom theme colors. Use Tailwind's built-in gray scale and status colors (red, green, yellow, orange), plus the accent as an arbitrary value (`[#9198E5]`). Class names like `bg-primary` or `text-secondary` resolve to nothing and must not be used.

### Import Pattern
```jsx
import { Icon1, Icon2, Icon3 } from 'lucide-react'
```

### Consistency
- Use consistent spacing: `gap-2`, `gap-3`, `gap-4`
- Use consistent border radius: `rounded-lg` for cards, `rounded-full` for pills/buttons
- Use consistent shadows: `shadow-sm` for subtle elevation
- Use consistent transitions: `transition-colors` for hover effects
