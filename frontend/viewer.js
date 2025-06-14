async function loadTokens(user = 'default') {
  try {
    const res = await fetch(`../vault/${user}/tokens.json`);
    const data = await res.json();
    document.getElementById('tokens').textContent = data.tokens;
  } catch {
    document.getElementById('tokens').textContent = '0';
  }
}

function renderMarkdown(text) {
  const html = text
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/\*\*(.*)\*\*/gim, '<b>$1</b>')
    .replace(/\*(.*)\*/gim, '<i>$1</i>')
    .replace(/\n$/gim, '<br />');
  return html;
}

function showPreview(file, content) {
  const preview = document.getElementById('preview');
  const ext = file.name.split('.').pop();
  if (ext === 'md') {
    preview.innerHTML = renderMarkdown(content);
  } else if (ext === 'json') {
    preview.innerHTML = `<pre>${JSON.stringify(JSON.parse(content), null, 2)}</pre>`;
  } else if (ext === 'yaml' || ext === 'yml') {
    preview.innerHTML = `<pre>${content}</pre>`;
    if(file.name.endsWith('.idea.yaml')){
      const c = document.createElement('div');
      c.innerHTML = `<button id="promote" class="px-2 py-1 bg-blue-500 text-white rounded mr-2">Promote</button><button id="export" class="px-2 py-1 bg-green-500 text-white rounded mr-2">Export</button><button id="fork" class="px-2 py-1 bg-purple-500 text-white rounded">Fork</button>`;
      preview.appendChild(c);
      c.querySelector('#promote').onclick = ()=>action('promote');
      c.querySelector('#export').onclick = ()=>action('export');
      c.querySelector('#fork').onclick = ()=>action('fork');
      function action(a){ fetch('/agent-action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:a,slug:file.name.replace(/\.idea\.yaml$/,'')})}).then(()=>alert(a+' sent')); }
    }
  } else {
    preview.innerHTML = `<pre>Loaded ${file.name} (${ext})</pre>`;
  }
}

async function handleFiles(files) {
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = e => {
      showPreview(file, e.target.result);
    };
    reader.readAsText(file);
  }
}

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.style.background = '#eee';
});
dropZone.addEventListener('dragleave', () => {
  dropZone.style.background = 'transparent';
});
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.style.background = 'transparent';
  handleFiles(e.dataTransfer.files);
});

document.getElementById('file-input').addEventListener('change', e => {
  handleFiles(e.target.files);
});

loadTokens();
