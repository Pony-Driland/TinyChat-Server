# TinyChat

**TinyChat** is a lightweight roleplay/RPG room server designed for integration with my website.
The project is currently in **beta**, but it is **fully available for free download and testing**.

TinyChat aims to provide a simple, modular, and efficient environment for real-time interactions in roleplay scenarios. Even though it is still under active development, all core features are functional and ready for community feedback.

## 🔧 Status

* **Version:** Beta
* **Availability:** Free to download, use, and test
* **Stability:** Mostly stable, but some features may still be refined or expanded

## 🌐 Hosting Requirements (PonyDriland)

The website **ponydriland.com** will only accept connections from servers hosted using **HTTPS**.
If your TinyChat server is running locally at home, you may use the built-in **proxy** as a shortcut to securely expose your database through an HTTPS-enabled tunnel.

## 📥 Download & Usage

You can freely download the project and start testing it right away.
Feedback, bug reports, and suggestions are welcome to help improve TinyChat during the beta cycle.

## 📦 Chat Archive CLI

Backup, migrate and edit your chat history from the terminal — export any room chapter to a
plain JSON file and import it back, with interactive room/chapter selection.

```bash
./build/chat-archive-cli.js rooms
./build/chat-archive-cli.js export --room lobby --chapter all --file lobby.json
./build/chat-archive-cli.js import --room lobby --chapter 2 --file lobby.json
```

📖 **[Full documentation →](docs/chat-archive-cli.md)**

## 🧩 About the Project

TinyChat was built to support:

* Roleplay/RPG chat rooms
* Real-time messaging
* Lightweight server performance

---

## 💡 Credits

> 🧠 **Note**: This documentation was written by [ChatGPT](https://openai.com/chatgpt), an AI assistant developed by OpenAI, based on the project structure and descriptions provided by the repository author.  
> If you find any inaccuracies or need improvements, feel free to contribute or open an issue!
