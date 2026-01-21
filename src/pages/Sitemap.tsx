import { useEffect } from 'react';

const Sitemap = () => {
  useEffect(() => {
    // Redirect to the edge function sitemap generator
    window.location.href = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sitemap`;
  }, []);

  return null;
};

export default Sitemap;
