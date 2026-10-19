export default async (_req, context) => {
  const response = await context.next();
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return response;

  const html = await response.text();
  const script = `
<style>
[data-delete-produto]{background:#b42318!important;border-color:#b42318!important;color:#fff!important}
[data-delete-produto]:hover{filter:brightness(.92)}
</style>
<script>
(function(){
  function senha(){return localStorage.getItem('senha')||''}
  function instalar(){
    document.querySelectorAll('.card[data-id]').forEach(function(card){
      if(card.querySelector('[data-delete-produto]')) return;
      var full=card.querySelector('.full');
      if(!full) return;
      var row=full.querySelector('.row');
      if(!row){row=document.createElement('div');row.className='row';full.insertBefore(row,full.firstChild)}
      var b=document.createElement('button');
      b.type='button';b.textContent='🗑️ Excluir produto';b.setAttribute('data-delete-produto','1');
      b.onclick=async function(){
        var id=card.getAttribute('data-id');
        var nome=(card.querySelector('.nome')||{}).textContent||'este produto';
        if(!confirm('Excluir definitivamente '+nome+'?\\n\\nEsta ação não pode ser desfeita.')) return;
        b.disabled=true;b.textContent='Excluindo…';
        try{
          var r=await fetch('/.netlify/functions/produto-deletar',{method:'POST',headers:{'x-senha':senha(),'content-type':'application/json'},body:JSON.stringify({id:id})});
          var j=await r.json();
          if(!r.ok||!j.ok) throw new Error(j.erro||'Não foi possível excluir o produto.');
          card.remove();
          if(typeof window.toast==='function') window.toast('Produto excluído com sucesso.');
          else alert('Produto excluído com sucesso.');
          if(typeof window.carregar==='function') window.carregar();
        }catch(e){b.disabled=false;b.textContent='🗑️ Excluir produto';alert('Erro ao excluir: '+e.message)}
      };
      row.appendChild(b);
    });
  }
  instalar();
  new MutationObserver(instalar).observe(document.body,{childList:true,subtree:true});
  setInterval(instalar,1500);
})();
</script>`;

  return new Response(html.replace(/<\\/body>/i, script + "</body>"), response);
};

export const config = {
  path: "/*",
  excludedPath: ["/.netlify/functions/*", "/assets/*", "/*.css", "/*.js", "/*.json", "/*.png", "/*.jpg", "/*.jpeg", "/*.webp", "/*.svg", "/*.ico"]
};
