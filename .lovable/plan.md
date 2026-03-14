

## Make "Video Tips" breadcrumb clickable

In `src/pages/marketing/VideoTipPage.tsx`, add an `href` to the first breadcrumb item so it links to the video tips listing page.

**Change** (line ~87):
```tsx
// From:
{ label: 'Video Tips' },

// To:
{ label: 'Video Tips', href: '/video-tips' },
```

One line change.

