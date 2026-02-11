

## Update Social Share (OG) Image with Logo and Text

### What happens when you share a link

Social platforms display three things from your page:
- **Image** (`og:image`) -- currently an old placeholder at `public/og-image.png`
- **Title** (`og:title`) -- already set dynamically per page (e.g. "Find Your Perfect Padel Trainer | PadelTrainer.ai")
- **Description** (`og:description`) -- already set dynamically per page

The title and description text are already working. Only the image needs replacing.

### Option: Branded OG Image with Text

Since you want text on the image itself, the best approach is to create a simple branded OG image (1200x630px, the standard size) that includes:
- The PadelTrainer.ai logo (from the uploaded files)
- A tagline, e.g. the hero subtitle or something like "Find Your Perfect Padel Trainer"
- Clean background matching brand colors

I will generate this as a static image file using an HTML canvas rendered to PNG via an edge function, then save it as `public/og-image.png`.

### Changes

1. **`public/og-image.png`** -- replace with a new branded image containing logo + tagline text
2. **No code changes needed** -- the SEO component already references this file as the default

### Text suggestion

The tagline on the image could be the hero title: the translated value of `home.hero.title` + `home.hero.titleHighlight`. I will check the English and Dutch marketing translations to pick the right text. Since OG images are static, we will use one language (English is standard for international reach, or Dutch if preferred).

### After publishing

Social platforms cache OG images. You may need to clear the cache using Facebook Sharing Debugger or LinkedIn Post Inspector to see the update.

