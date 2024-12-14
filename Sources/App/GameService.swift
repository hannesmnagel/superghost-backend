import Vapor
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

actor GameService {
    static let shared = GameService()

    private var openGames: [String: Game] = [:]
    private var currentGames: [String: Game] = [:]

    private var sockets: [String: [WebSocket]] = [:]
    private let logger = Logger(label: "super.ghost.gameservice")
    private init() {}

    func getEmptyGameId(isSuperghost: Bool) -> String? {
        Logger(label: "game.getEmptyGameId").info("finding empty game: \(openGames.values.first(where: { $0.player2Id != "privateGame" && $0.isSuperghost == isSuperghost})?.id ?? "none")")
        return openGames.values.first(where: { $0.player2Id != "privateGame" && $0.isSuperghost == isSuperghost})?.id
    }

    func createGame(player1Id: String, player1Profile: PlayerProfile, isPrivate: Bool, isSuperghost: Bool) -> String {
        let game = Game(player1Id: player1Id, player1profile: player1Profile, player2Id: isPrivate ? "privateGame" : "", isSuperghost: isSuperghost)

        openGames[game.id] = game
        notifyGameChanged(.init(word: game.word, player1Id: game.player1Id, player1Profile: game.player1profile, player2Id: game.player2Id, isBlockingMoveForPlayerOne: game.isBlockingMoveForPlayerOne, player1Wins: game.player1Wins, player1Challenges: game.player1Challenges, rematchGameId: game.rematchGameId), for: game.id)

        // Start a timer to add bot if no player joins in 4 seconds

        if !isPrivate {
            Task {
                try await Task.sleep(nanoseconds: 4 * 1_000_000_000)
                await self.addBotToGameIfEmpty(gameId: game.id)
            }
        }

        return game.id
    }
    func joinGame(playerId: String, playerProfile: PlayerProfile, gameId: String) {
        defer{
            Logger(label: "game.word.join").info("exited")
        }
        guard var game = openGames[gameId] else {return}
        game.isBlockingMoveForPlayerOne = false
        game.player2profile = playerProfile
        game.player2Id = playerId
        openGames.removeValue(forKey: gameId)
        currentGames[gameId] = game
        notifyGameChanged(.init(word: game.word, player1Id: game.player1Id, player1Profile: game.player1profile, player2Id: game.player2Id, player2Profile: game.player2profile, isBlockingMoveForPlayerOne: game.isBlockingMoveForPlayerOne, player1Wins: game.player1Wins, player1Challenges: game.player1Challenges, rematchGameId: game.rematchGameId, isSuperghost: game.isSuperghost), for: gameId)
        Logger(label: "game.join").info("joined")
    }
    func appendLetter(_ letter: String, to gameId: String) {
        defer{
            Logger(label: "game.word.append").info("exited")
        }
        guard var game = currentGames[gameId] else { return }
        game.word.append(letter)
        game.isBlockingMoveForPlayerOne.toggle()
        currentGames[gameId] = game
        notifyGameChanged(GameMove(word: game.word, isBlockingMoveForPlayerOne: game.isBlockingMoveForPlayerOne), for: game.id)
        Logger(label: "game.word.append").info("appended")
    }
    func prependLetter(_ letter: String, to gameId: String) {
        defer{
            Logger(label: "game.word.prepend").info("exited")
        }
        guard var game = currentGames[gameId] else { return }
        game.word = "\(letter)\(game.word)"
        game.isBlockingMoveForPlayerOne.toggle()
        currentGames[gameId] = game
        notifyGameChanged(GameMove(word: game.word, isBlockingMoveForPlayerOne: game.isBlockingMoveForPlayerOne), for: game.id)
        Logger(label: "game.word.prepend").info("prepended")
    }
    func looseWithWord(_ word: String, player: String, in gameId: String) {
        defer{
            Logger(label: "game.word.loose").info("exited")
        }
        guard var game = currentGames[gameId] else { return }
        game.word = word
        game.player1Wins = player != game.player1Id
        game.isBlockingMoveForPlayerOne.toggle()
        currentGames[gameId] = game
        notifyGameChanged(GameMove(word: game.word, isBlockingMoveForPlayerOne: game.isBlockingMoveForPlayerOne, player1Wins: game.player1Wins), for: game.id)
    }
    func challenge(by player: String, in gameId: String) {
        defer{
            Logger(label: "game.word.challenge").info("exited")
        }
        guard var game = currentGames[gameId] else { return }
        game.player1Challenges = player == game.player1Id
        game.isBlockingMoveForPlayerOne.toggle()
        currentGames[gameId] = game
        notifyGameChanged(GameMove(isBlockingMoveForPlayerOne: game.isBlockingMoveForPlayerOne, player1Challenges: game.player1Challenges), for: game.id)
    }
    func submitWordAfterChallenge(_ word: String, by player: String, in gameId: String) {
        defer{
            Logger(label: "game.word.submitword").info("exited")
        }
        if let game = currentGames[gameId]{
            Logger(label:"game.word.submitword").info("\(description(for: game))")
        } else {
            Logger(label:"game.word.submitword").info("no current game found")
        }
        guard var game = currentGames[gameId] else { return }
        guard word.localizedCaseInsensitiveContains(game.word) else { return }
        game.word = word
        game.player1Wins = player == game.player1Id
        game.isBlockingMoveForPlayerOne.toggle()
        currentGames[gameId] = game
        notifyGameChanged(GameMove(word: game.word, isBlockingMoveForPlayerOne: game.isBlockingMoveForPlayerOne, player1Wins: game.player1Wins), for: game.id)
        Logger(label:"game.word.submitword").info("end\n \(description(for: game))")
    }
    func yesIliedAfterChallenge(by player: String, in gameId: String) {
        defer{
            Logger(label: "game.word.yesilied").info("exited")
        }
        guard var game = currentGames[gameId] else { return }
        game.player1Wins = player != game.player1Id
        game.isBlockingMoveForPlayerOne.toggle()
        currentGames[gameId] = game
        notifyGameChanged(GameMove(isBlockingMoveForPlayerOne: game.isBlockingMoveForPlayerOne, player1Wins: game.player1Wins), for: game.id)
    }
    func rematchGame(from oldGameId: String, to newGameId: String) {
        defer{
            Logger(label: "game.rematch").info("exited")
        }
        guard var game = currentGames[oldGameId] else { return }
        game.rematchGameId = newGameId
        currentGames[oldGameId] = game
        notifyGameChanged(.init(isBlockingMoveForPlayerOne: game.isBlockingMoveForPlayerOne, rematchGameId: game.rematchGameId), for: oldGameId)
    }

    private func addBotToGameIfEmpty(gameId: String) async {
        guard var game = openGames[gameId], game.player2Id.isEmpty else { return }
        game.player2Id = "botPlayer"
        game.isBlockingMoveForPlayerOne = false
        openGames.removeValue(forKey: gameId)
        currentGames[gameId] = game
        notifyGameChanged(.init(player2Id: "botPlayer", isBlockingMoveForPlayerOne: false), for: gameId)
    }

    func deleteGame(by id: String) {
        defer{
            Logger(label: "game.delete").info("exited")
        }
        openGames.removeValue(forKey: id)
        sockets[id]?.forEach { _ = $0.close() }
        sockets.removeValue(forKey: id)
    }

    func addSocket(_ socket: WebSocket, forGameId id: String) {
        defer{
            Logger(label: "game.addSocket").info("exited")
        }
        if sockets[id] != nil {
            sockets[id]?.append(socket)
        } else {
            sockets[id] = [socket]
        }
        Logger(label: "game.addSocket").info("added socket to total count \(sockets.count)")

        socket.onClose.whenComplete { _ in
            Logger(label: "game.addSocket").info("closed socket")
            Task {[weak self] in
                let startingGame = await self?.currentGames[id]
                try? await Task.sleep(nanoseconds: 20*1_000_000_000)
                if await self?.currentGames[id] == startingGame || startingGame == nil {
                    await self?.deleteGame(by: id)
                }
            }
        }
    }

    private func notifyGameChanged(_ change: GameMove, for id: String) {
        if let notifyingSockets = sockets[id] {
            if let data = try? JSONEncoder().encode(change).base64EncodedString() {
                notifyingSockets.forEach { $0.send(data) }
            }
        }
        if let game = currentGames[id],
           game.player2Id == "botPlayer",
           game.isBlockingMoveForPlayerOne {
            Task {
                try? await makeMove(for: game)
            }
        }
    }

    private func makeMove(for game: Game) async throws {
        // Implement bot's move logic here
        try? await Task.sleep(nanoseconds: 4 * 1_000_000_000)
        defer{
            Logger(label: "game.botmove").info("exited")
        }
        guard game.player1Wins == nil else {return}


        let words = try await searchWordsContaining(string: game.word)
        let abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".map({String($0)}).shuffled()

        //When challenged:
        if game.player1Challenges == true {
            Logger(label: "game.botmove").info("ischallenged")
            for possibleWord in words {
                if (try await isWord(possibleWord)) && possibleWord.localizedCaseInsensitiveContains(game.word) {
                    submitWordAfterChallenge(possibleWord, by: "botPlayer", in: game.id)
                    Logger(label: "game.botmove").info("submits \(possibleWord)")
                    return
                }
            }
            yesIliedAfterChallenge(by: "botPlayer", in: game.id)
            Logger(label: "game.botmove").info("lied")
            return
        }

        //when not challenged

        for char in abc {
            var testWord = game.word.appending(char)
            if try await !isWord(testWord) && words.contains(where: {$0.localizedCaseInsensitiveContains(testWord)}) {
                appendLetter(char, to: game.id)
                Logger(label: "game.botmove").info("appends -> \(testWord)")
                return
            }
            if game.isSuperghost{
                testWord = "\(char)\(game.word)"
                if try await !isWord(testWord) && words.contains(where: {$0.localizedCaseInsensitiveContains(testWord)}) {
                    prependLetter(char, to: game.id)
                    Logger(label: "game.botmove").info("prepends -> \(testWord)")
                    return
                }
            }
        }
        //if no possible other words
        for char in abc {
            var testWord = game.word.appending(char)
            if words.contains(where: {$0.localizedCaseInsensitiveContains(testWord)}) {
                looseWithWord(testWord, player: "botPlayer", in: game.id)
                Logger(label: "game.botmove").info("looses with \(testWord)")
                return
            }
            if game.isSuperghost {
                testWord = "\(char)\(game.word)"
                if words.contains(where: {$0.localizedCaseInsensitiveContains(testWord)}) {
                    looseWithWord(testWord, player: "botPlayer", in: game.id)
                    Logger(label: "game.botmove").info("looses with \(testWord)")
                    return
                }
            }
        }
        challenge(by: "botPlayer", in: game.id)
        Logger(label: "game.botmove").info("challenges")
    }
}
