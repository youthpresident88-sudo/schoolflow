(function () {
  const SF = window.SF;
  const { api } = SF;
  const { html, mount, ago, fail, formModal, cap, badge } = SF.ui;

  SF.views.messages = {
    title: 'Messages',
    async render(el, args, ctx) {
      const state = { other: Number(args[0]) || null };
      mount(el, html`<div class="chat">
        <div><button class="btn btn-primary btn-block" id="new" style="margin-bottom:10px">+ New message</button><div class="chat-list" id="list"></div></div>
        <div class="chat-pane" id="pane"><div class="empty">Choose a conversation or start a new one.</div></div></div>`);
      const list = el.querySelector('#list'); const pane = el.querySelector('#pane');

      async function loadThreads() {
        const threads = await api('GET', '/api/messages/threads');
        mount(list, threads.length ? html`${threads.map((t) => html`<button data-uid="${t.user_id}" class="${state.other === t.user_id ? 'active' : ''}"><b><span>${t.name}</span>${t.unread ? badge(t.unread, 'red') : ''}</b><span>${cap(t.role)} · ${t.last_body}</span></button>`)}` : html`<div class="empty small">No conversations yet.</div>`);
        list.querySelectorAll('[data-uid]').forEach((b) => b.addEventListener('click', () => open(Number(b.dataset.uid))));
      }

      async function open(uid, fresh = true) {
        state.other = uid;
        try {
          const d = await api('GET', `/api/messages/with/${uid}`);
          const me = SF.me.user.id;
          mount(pane, html`<div class="list-row" style="padding:12px 14px;margin:0"><b>${d.user.name}</b><span class="muted small">${cap(d.user.role)}</span></div>
            <div class="chat-msgs" id="msgs">${d.messages.length ? d.messages.map((m) => html`<div class="bubble ${m.from_user_id === me ? 'me' : ''}">${m.body}<small>${ago(m.created_at)}</small></div>`) : html`<div class="empty small">Say hello 👋</div>`}</div>
            <form class="chat-form" id="send"><input id="text" placeholder="Write a message…" maxlength="1000" autocomplete="off" aria-label="Message"><button class="btn btn-primary" type="submit">Send</button></form>`);
          const box = pane.querySelector('#msgs'); box.scrollTop = box.scrollHeight;
          pane.querySelector('#send').addEventListener('submit', async (e) => {
            e.preventDefault();
            const input = pane.querySelector('#text'); const body = input.value.trim();
            if (!body) return;
            input.value = '';
            try { await api('POST', '/api/messages', { to_user_id: uid, body }); await open(uid); await loadThreads(); } catch (err) { fail(err); input.value = body; }
          });
          if (fresh) { await loadThreads(); SF.refreshBadges(); }
        } catch (e) { fail(e); }
      }

      el.querySelector('#new').addEventListener('click', async () => {
        const contacts = await api('GET', '/api/messages/contacts');
        formModal({
          title: 'New message', submitLabel: 'Open conversation',
          fields: [{ name: 'to', label: 'To', type: 'select', required: true, placeholder: 'Choose a person…', full: true, options: contacts.map((c) => ({ value: c.id, label: `${c.name} (${cap(c.role)})` })) }],
          onSubmit: async (d) => { await open(Number(d.to), false); },
        });
      });

      await loadThreads();
      if (state.other) await open(state.other, false);
      // gentle polling while this page is open
      const timer = setInterval(() => {
        if (!ctx.isCurrent() || !document.body.contains(el)) { clearInterval(timer); return; }
        loadThreads().catch(() => {}); SF.refreshBadges();
      }, 20000);
    },
  };
})();
