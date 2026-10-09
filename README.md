# Discordo

**Aplicativo web de conversas e compartilhamento de tela ao vivo.** Interface inspirada na organização do Discord, com identidade própria.

## Funcionalidades da primeira versão

- Criar um servidor e canais de texto e voz.
- Entrar em servidores com link ou código de convite.
- Conversar por texto em tempo real com participantes conectados.
- Participar de uma sala de voz e ativar/desativar microfone.
- **Transmitir tela, janela ou guia ao vivo**, com autorização explícita do navegador.
- Assistir às telas compartilhadas por pessoas na mesma sala de voz.
- Identificar quem está online, em voz ou transmitindo.
- Visual responsivo e indicação de transmissão ativa.

## Como testar com outra pessoa

1. Abra o site publicado com HTTPS no **Chrome ou Edge para computador**.
2. Digite um apelido.
3. Clique em **Convidar** e envie o link para outra pessoa.
4. Ambos selecionam o canal de voz **Geral** e clicam em **Entrar na sala**.
5. Quem quiser mostrar a tela clica em **Transmitir tela**, escolhe janela/guia/tela e confirma.
6. A outra pessoa verá o vídeo ao vivo na sala. Para falar, clique em **Ativar microfone**.

Dica: use dois computadores ou dois navegadores e perfis diferentes. Com um único computador, cuidado com microfonia: use fones.

## Tecnologia

- HTML, CSS e JavaScript puro; sem compilação.
- WebRTC para mídia em tempo real.
- PeerJS para facilitar a conexão entre navegadores; utiliza o servidor público de sinalização do PeerJS para este protótipo.
- Armazenamento local (localStorage) para apelido, servidores e cache de mensagens.
- GitHub Pages para hospedar os arquivos estáticos via HTTPS.

## Publicação no GitHub Pages

Este repositório inclui a automação de deploy na pasta .github/workflows/pages.yml.

1. Acesse **Settings → Pages** no GitHub.
2. Em **Build and deployment → Source**, selecione **GitHub Actions**.
3. Abra **Actions** e execute novamente o workflow **Publish Discordo** se necessário.
4. O endereço previsto é **https://eulernasc.github.io/discordo/** após a publicação ficar concluída.

O GitHub Pages hospeda a interface. A comunicação e a tela passam diretamente entre navegadores via WebRTC; o serviço público PeerJS participa da sinalização inicial.

## Limitações importantes desta versão

- **MVP para grupos pequenos**: cada transmissor envia vídeo separadamente a cada espectador. A qualidade e o número de espectadores dependem da banda e do dispositivo do transmissor. Não equivale à infraestrutura SFU do Discord.
- **Sem login/senha ou permissões avançadas**: quem tiver o código pode entrar. Não use para informações confidenciais ou salas sensíveis.
- **Sem histórico centralizado**: o histórico da sala fica em memória no computador coordenador e o cache local pode ser diferente entre dispositivos. Ao mudar o coordenador, mensagens antigas podem não aparecer.
- **Dependência do sinalizador público PeerJS e da conectividade WebRTC**: redes empresariais ou NATs restritivos podem impedir conexões; uma versão de produção exige servidor próprio ou serviço SFU/TURN.
- **Permissões e limitações do navegador**: tela precisa de HTTPS, clique do usuário e autorização em cada transmissão; captura de áudio do sistema e compartilhamento no celular variam por navegador/SO. O compartilhamento de tela móvel não está garantido.
- Não grava as transmissões no servidor.

## Próxima etapa para escala

Para dezenas de pessoas, persistência de mensagens e permissões reais, migrar para autenticação e banco de dados (por exemplo Firebase) + uma SFU gerenciada (por exemplo LiveKit) com tokens de acesso gerados por backend e infraestrutura TURN. Isso não está incluso neste MVP.
