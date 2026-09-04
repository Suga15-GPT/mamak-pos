import { $, esc, toast } from './state.js';

// Cached so the per-row Edit/Reset PIN/Deactivate handlers don't need an
// extra round-trip to know the current name/role they're acting on.
let lastStaff = [];

/* ===== ADMIN: STAFF & PINS CARD ===== */
export async function refreshStaff() {
  try {
    const users = await API.get('/api/admin/users');
    lastStaff = users;
    const active = users.filter(u => u.active);
    const former = users.filter(u => !u.active);

    $('admin-staff').innerHTML = active.map(u => `
      <div class="admin-row">
        <div>
          <b>${esc(u.name)}</b> <span class="meta">${esc(u.role)}</span>
          ${u.must_change_pin ? '<span class="meta" style="color:var(--terra-deep)"> · must change PIN</span>' : ''}
          <div class="meta">Last active: ${u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : 'never'}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn small outline" data-action="edit-staff" data-id="${u.id}">Edit</button>
          <button class="btn small outline" data-action="reset-staff-pin" data-id="${u.id}">Reset PIN</button>
          <button class="btn-danger" data-action="deactivate-staff" data-id="${u.id}">Deactivate</button>
        </div>
      </div>`).join('') || '<div class="empty">No active staff</div>';

    $('admin-staff-former').innerHTML = former.length
      ? former.map(u => `
        <div class="admin-row">
          <div><b>${esc(u.name)}</b> <span class="meta">${esc(u.role)}</span>
            <div class="meta">Left ${u.left_at ? new Date(u.left_at).toLocaleDateString() : '—'}</div></div>
        </div>`).join('')
      : '<div class="empty">No former staff</div>';
  } catch (e) { toast('Staff load error: ' + e.message); console.error(e); }
}

async function createStaff() {
  const name = $('new-staff-name').value.trim();
  const role = $('new-staff-role').value;
  const pin = $('new-staff-pin').value.trim();
  const confirmPin = $('new-staff-pin-confirm').value.trim();
  if (!name) return toast('Enter a name');
  if (pin !== confirmPin) return toast('PIN and confirmation do not match');
  try {
    await API.post('/api/admin/users', { name, role, pin });
    $('new-staff-name').value = ''; $('new-staff-pin').value = ''; $('new-staff-pin-confirm').value = '';
    toast(`${name} added — they will choose their own PIN at first login`);
    refreshStaff();
  } catch (e) { toast(e.message); }
}

function editStaff(id, current) {
  const name = prompt('Name:', current.name);
  if (name === null) return;
  const role = prompt('Role (admin/staff/kitchen):', current.role);
  if (role === null) return;
  API.patch('/api/admin/users/' + id, { name: name.trim(), role: role.trim() })
    .then(() => { toast('Updated'); refreshStaff(); })
    .catch(e => toast(e.message));
}

async function deactivateStaff(id, name) {
  if (!confirm(`Deactivate ${name}? They will be signed out immediately and can no longer log in.`)) return;
  try { await API.patch('/api/admin/users/' + id, { active: false }); toast(`${name} deactivated`); refreshStaff(); }
  catch (e) { toast(e.message); }
}

async function resetStaffPin(id, name) {
  const newPin = prompt(`New temporary PIN for ${name} (4-8 digits — they will be asked to change it at next login):`);
  if (newPin === null) return;
  try {
    await API.post(`/api/admin/users/${id}/reset-pin`, { new_pin: newPin.trim() });
    toast(`${name}'s PIN reset`);
    refreshStaff();
  } catch (e) { toast(e.message); }
}

function findStaff(id) {
  return lastStaff.find(u => u.id === id) || { name: '', role: 'staff' };
}

$('tab-admin').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'create-staff') createStaff();
  else if (action === 'edit-staff') editStaff(Number(el.dataset.id), findStaff(Number(el.dataset.id)));
  else if (action === 'deactivate-staff') { const u = findStaff(Number(el.dataset.id)); deactivateStaff(u.id, u.name); }
  else if (action === 'reset-staff-pin') { const u = findStaff(Number(el.dataset.id)); resetStaffPin(u.id, u.name); }
});

/* ===== "CHANGE MY PIN" — every role, header ===== */
let pinDialogMandatory = false;

export function openChangePinDialog(mandatory = false) {
  pinDialogMandatory = mandatory;
  $('pin-current').value = '';
  $('pin-new').value = '';
  $('pin-new-confirm').value = '';
  $('pin-modal-cancel').style.display = mandatory ? 'none' : '';
  $('pin-modal-title').textContent = mandatory ? 'Choose a new PIN before continuing' : 'Change my PIN';
  $('pin-modal').classList.add('show');
}
function closeChangePinDialog() {
  if (pinDialogMandatory) return; // cannot be dismissed while mandatory
  $('pin-modal').classList.remove('show');
}

async function submitChangePin() {
  const current_pin = $('pin-current').value.trim();
  const new_pin = $('pin-new').value.trim();
  const confirmPin = $('pin-new-confirm').value.trim();
  if (new_pin !== confirmPin) return toast('New PIN and confirmation do not match');
  try {
    await API.post('/api/me/pin', { current_pin, new_pin });
    API.user.must_change_pin = false;
    localStorage.setItem('pos_user', JSON.stringify(API.user));
    const wasMandatory = pinDialogMandatory;
    pinDialogMandatory = false;
    $('pin-modal').classList.remove('show');
    toast('PIN changed — every other device you were signed in on has been signed out');
    // main.js held off loading menu/tables/the stream until this resolved.
    if (wasMandatory) document.dispatchEvent(new Event('pin-changed-mandatory'));
  } catch (e) { toast(e.message); }
}

$('pin-modal').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) {
    if (el.dataset.action === 'submit-change-pin') submitChangePin();
    else if (el.dataset.action === 'close-pin-modal') closeChangePinDialog();
    return;
  }
  if (e.target === $('pin-modal')) closeChangePinDialog();
});
