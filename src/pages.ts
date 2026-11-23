/** Páginas públicas exigidas pela tela de consentimento do Google (página inicial e política de privacidade). */

const layout = (title: string, body: string) =>
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.55;color:#1f2328}` +
  `h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:1.8rem}a{color:#0969da}</style></head><body>${body}</body></html>`;

export function homePage(contact: string) {
  return layout(
    'Gmail MCP pessoal',
    `<h1>Gmail MCP pessoal</h1>
<p>Servidor de uso estritamente pessoal que conecta o Claude (claude.ai) ao Gmail de um único usuário,
por meio do Model Context Protocol (MCP). Não é um serviço aberto ao público: apenas a conta do próprio titular pode autorizá-lo.</p>
<p>O que ele faz: ler e buscar e-mails, gerenciar rascunhos e marcadores, arquivar e, mediante confirmação explícita do titular,
enviar, responder e encaminhar mensagens. Ele não exclui mensagens, não usa a lixeira e não altera configurações da conta.</p>
<p><a href="/privacidade">Política de privacidade</a> · Contato: ${contact}</p>`,
  );
}

export function privacyPage(contact: string) {
  return layout(
    'Política de privacidade — Gmail MCP pessoal',
    `<h1>Política de privacidade</h1>
<p>Última atualização: novembro de 2026.</p>
<h2>Quem usa</h2>
<p>Este aplicativo é de uso pessoal e exclusivo do seu titular (${contact}). Qualquer outra conta Google é recusada.</p>
<h2>Dados acessados</h2>
<p>Com a autorização do titular, o aplicativo acessa o Gmail (escopo <code>gmail.modify</code>) e o endereço de e-mail da conta,
apenas para executar as ações pedidas pelo titular no Claude: buscar e ler mensagens, gerenciar rascunhos e marcadores, arquivar
e enviar/responder/encaminhar com confirmação explícita.</p>
<h2>O que é armazenado</h2>
<ul>
<li>O token de atualização do Google, criptografado (AES-256-GCM).</li>
<li>Registros técnicos de autorização (somente hashes de tokens) e uma auditoria de envios com data, identificador da mensagem e
quantidade de destinatários — sem endereços, assunto, corpo ou anexos.</li>
</ul>
<p>O conteúdo dos e-mails não é armazenado nem registrado em log pelo servidor; ele é repassado apenas ao Claude, na conversa do titular.</p>
<h2>Compartilhamento</h2>
<p>Os dados não são vendidos, compartilhados com terceiros nem usados para publicidade ou treinamento de modelos.
O uso de dados recebidos das APIs do Google segue a
<a href="https://developers.google.com/terms/api-services-user-data-policy">Política de Dados do Usuário dos Serviços de API do Google</a>,
incluindo os requisitos de Uso Limitado.</p>
<h2>Revogação e exclusão</h2>
<p>O acesso pode ser revogado a qualquer momento em
<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> ou desconectando o conector no claude.ai.
Com a revogação, o token armazenado deixa de funcionar e é apagado.</p>
<h2>Contato</h2>
<p>${contact}</p>`,
  );
}
