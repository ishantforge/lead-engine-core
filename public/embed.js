(function () {
  const script = document.currentScript;
  const clientSlug = script.getAttribute('data-client') || 'demo';
  const primaryColor = script.getAttribute('data-color') || '#0f172a';

  // 1. Create floating container
  const container = document.createElement('div');
  container.id = 'lead-engine-widget';
  container.style.position = 'fixed';
  container.style.bottom = '24px';
  container.style.right = '24px';
  container.style.zIndex = '999999';
  container.style.fontFamily = 'system-ui, -apple-system, sans-serif';

  // 2. Create toggle button
  const triggerBtn = document.createElement('button');
  triggerBtn.innerHTML = '⚡ Instant Inquiry';
  triggerBtn.style.cssText = `
    background: ${primaryColor};
    color: #ffffff;
    border: none;
    padding: 12px 20px;
    border-radius: 9999px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 10px 25px rgba(0,0,0,0.15);
    transition: transform 0.2s ease;
  `;

  // 3. Create iframe modal
  const frame = document.createElement('iframe');
  frame.src = `https://lead-engine-core.vercel.app?client=${clientSlug}`;
  frame.style.cssText = `
    display: none;
    width: 380px;
    height: 580px;
    border: 1px solid #e2e8f0;
    border-radius: 16px;
    box-shadow: 0 20px 40px rgba(0,0,0,0.2);
    margin-bottom: 12px;
  `;

  triggerBtn.onclick = () => {
    frame.style.display = frame.style.display === 'none' ? 'block' : 'none';
  };

  container.appendChild(frame);
  container.appendChild(triggerBtn);
  document.body.appendChild(container);
})();
