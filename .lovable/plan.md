

## Replace Email Logo with Official PNG

### What
Replace the AI-generated `public/logo-dark.png` with the uploaded official logo (image 2: `user-uploads://2.png`), which shows the full "PadelTrainer.ai" text clearly on a white background.

### Why image 2
- Image 1 has transparent background -- the dark "PadelTrainer." text is invisible on white email backgrounds
- Image 2 has white background with the full logo visible -- perfect for emails since they have white backgrounds

### Steps
1. Copy `user-uploads://2.png` to `public/logo-dark.png` (overwriting the AI-generated version)
2. No edge function changes needed -- they already reference `https://padeltrainer.ai/logo-dark.png`
3. Deploy and send a test email to verify it renders correctly on iPhone/Gmail

### Files changed
| File | Change |
|------|--------|
| `public/logo-dark.png` | Replace with uploaded official logo |

