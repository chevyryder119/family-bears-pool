// public/app.js
const PRICE_PER_SQUARE = 20;
let gridData = [];
let selected = new Set();

async function loadGrid() {
  const res = await fetch('/api/grid');
  gridData = await res.json();
  renderGrid();
}

function renderGrid() {
  const container = document.getElementById('grid');
  container.innerHTML = '';
  const table = document.createElement('div');
  table.className = 'grid-table';
  gridData.forEach(cell => {
    const cellEl = document.createElement('div');
    cellEl.className = 'cell';
    cellEl.dataset.id = cell.id;

    if (cell.purchased) {
      cellEl.classList.add('taken');
      cellEl.textContent = `Taken`;
      cellEl.title = cell.owner_name || 'Taken';
    } else {
      const idSpan = document.createElement('div');
      idSpan.textContent = `${cell.id}`;
      idSpan.style.fontWeight = '700';
      idSpan.style.marginBottom = '6px';

      const buyBtn = document.createElement('button');
      buyBtn.textContent = 'Buy';
      buyBtn.className = 'buy-inline';
      buyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        window.location = `/buy/${cell.id}`;
      });

      cellEl.appendChild(idSpan);
      cellEl.appendChild(buyBtn);

      cellEl.addEventListener('click', () => toggleSelect(cell.id, cell.purchased));
    }

    table.appendChild(cellEl);
  });
  container.appendChild(table);
  updateSelectionPanel();
}

function toggleSelect(id, isTaken) {
  if (isTaken) return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  updateSelectionPanel();
  document.querySelectorAll('.cell').forEach(c => {
    const cid = parseInt(c.dataset.id);
    if (selected.has(cid)) c.classList.add('selected'); else c.classList.remove('selected');
  });
}

function updateSelectionPanel() {
  const count = selected.size;
  document.getElementById('count').textContent = count;
  document.getElementById('total').textContent = (count * PRICE_PER_SQUARE).toFixed(2);
  document.getElementById('purchaseBtn').disabled = count === 0;
}

document.getElementById('purchaseBtn').addEventListener('click', async () => {
  const purchaserName = document.getElementById('name').value.trim();
  const purchaserEmail = document.getElementById('email').value.trim();
  if (!purchaserName || !purchaserEmail) {
    alert('Please enter your name and email.');
    return;
  }
  const squareIds = Array.from(selected);
  const res = await fetch('/api/create-checkout-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ squareIds, purchaserName, purchaserEmail })
  });
  const j = await res.json();
  if (res.ok && j.url) {
    window.location = j.url;
  } else {
    alert('Error creating checkout session: ' + (j.error || JSON.stringify(j)));
    if (j.taken) {
      loadGrid();
    }
  }
});

// Live scoring via SSE
const evtSource = new EventSource('/scores/stream');
evtSource.onmessage = function(e) {
  try {
    const data = JSON.parse(e.data);
    renderScore(data);
  } catch (err) {
    console.error('Failed to parse SSE data', err);
  }
};

function renderScore(data) {
  const el = document.getElementById('game-status');
  if (!data) return;
  if (data.active && data.game) {
    const g = data.game;
    el.innerHTML = `${g.home} ${g.home_score} — ${g.away} ${g.away_score} (${g.period} ${g.clock || ''})`;
  } else {
    el.textContent = 'No active game (demo mode)';
  }
}

// On load
loadGrid();
