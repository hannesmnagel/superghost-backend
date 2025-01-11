import Vapor
import WebSocketKit
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

func routes(_ app: Application) throws {

	app.get("apple-app-site-association") { req -> Response in
    let jsonString = """
    {
      "applinks": {
        "apps": [],
        "details": [
          {
            "appID": "X5933694SW.com.nagel.superghost",
            "paths": [ "*" ]
          }
        ]
      }
    }
    """
    
    var headers = HTTPHeaders()
    headers.add(name: .contentType, value: "application/json")
    return Response(status: .ok, headers: headers, body: .init(string: jsonString))
}

    //Serving template for private games: superghost/private/*
    app.get("v3", "private", "*"){req async throws in
        try await req.fileio.asyncStreamFile(at: app.directory.publicDirectory.appending("joinGameInSuperghostApp"))
    }

    //MARK: API

    app.post("v3", "game", "create") { req async throws -> String in
        struct CreateGameRequest: Content {
            let player1Id: String
            let player1profile: PlayerProfile
            let isPrivate: Bool
            let isSuperghost: Bool
        }
        let request = try req.content.decode(CreateGameRequest.self)
        let id = await GameService.shared.createGame(player1Id: request.player1Id, player1Profile: request.player1profile, isPrivate: request.isPrivate, isSuperghost: request.isSuperghost)
        return id
    }
    app.put("v3", "game", "open") { req async throws -> String in
        let isSuperghost = try req.content.decode(Bool.self)
        if let id = await GameService.shared.getEmptyGameId(isSuperghost: isSuperghost) {
            return id
        }
        throw Abort(.notFound)
    }

    app.post("v3", "game", "join") { req async throws -> HTTPStatus in
        struct JoinGameRequest: Content {
            var gameId: String
            var playerId: String
            var playerProfile: PlayerProfile
        }
        let joinGameRequest = try req.content.decode(JoinGameRequest.self)
        await GameService.shared.joinGame(playerId: joinGameRequest.playerId, playerProfile: joinGameRequest.playerProfile, gameId: joinGameRequest.gameId)
        return .ok
    }

    app.put("v3", "game", "append") { req async throws -> HTTPStatus in
        struct AppendRequest: Content {
            let letter: String
            let gameId: String
        }
        let appendRequest = try req.content.decode(AppendRequest.self)
        await GameService.shared.appendLetter(appendRequest.letter, to: appendRequest.gameId)
        return .ok
    }
    app.put("v3", "game", "prepend") { req async throws -> HTTPStatus in
        struct PrependRequest: Content {
            let letter: String
            let gameId: String
        }
        let prependRequest = try req.content.decode(PrependRequest.self)
        await GameService.shared.prependLetter(prependRequest.letter, to: prependRequest.gameId)
        return .ok
    }
    app.put("v3", "game", "looseWithWord") { req async throws -> HTTPStatus in
        struct LooseWithWordRequest: Content {
            let word: String
            let playerId: String
            let gameId: String
        }

        let looseWithWordRequest = try req.content.decode(LooseWithWordRequest.self)
        await GameService.shared.looseWithWord(looseWithWordRequest.word, player: looseWithWordRequest.playerId, in: looseWithWordRequest.gameId)
        return .ok
    }
    app.put("v3", "game", "challenge") { req async throws -> HTTPStatus in
        struct ChallengeRequest: Content {
            let playerId: String
            let gameId: String
        }

        let request = try req.content.decode(ChallengeRequest.self)
        await GameService.shared.challenge(by: request.playerId, in: request.gameId)
        return .ok
    }
    app.put("v3", "game", "submitWordAfterChallenge") { req async throws -> HTTPStatus in
        struct WordSubmitRequest: Content {
            let playerId: String
            let word: String
            let gameId: String
        }

        let request = try req.content.decode(WordSubmitRequest.self)
        await GameService.shared.submitWordAfterChallenge(request.word, by: request.playerId, in: request.gameId)
        return .ok
    }
    app.put("v3", "game", "yesIliedAfterChallenge") { req async throws -> HTTPStatus in
        struct YesILiedRequest: Content {
            let playerId: String
            let gameId: String
        }

        let request = try req.content.decode(YesILiedRequest.self)
        await GameService.shared.yesIliedAfterChallenge(by: request.playerId, in: request.gameId)
        return .ok
    }
    app.put("v3", "game", "rematchGame") { req async throws -> HTTPStatus in
        struct RematchRequest: Codable {
            let oldGameId: String
            let newGameId: String
        }

        let request = try req.content.decode(RematchRequest.self)
        await GameService.shared.rematchGame(from: request.oldGameId, to: request.newGameId)
        return .ok
    }

    app.delete("v3", "game") { req -> HTTPStatus in
        let gameId = try req.content.decode(String.self)
        await GameService.shared.deleteGame(by: gameId)
        return .ok
    }
    app.webSocket("v3", "game", "subscribe", ":gameId") { req, ws in
        Task{
            guard let gameId = req.parameters.get("gameId") else {
                return
            }

            await GameService.shared.addSocket(ws, forGameId: gameId)
        }
    }
}



struct Game: Equatable {
    var id: String = UUID().uuidString

    var player1Id: String
    var player1profile: PlayerProfile

    var player2Id = ""
    var player2profile: PlayerProfile?

    var isBlockingMoveForPlayerOne = true

    var player1Wins = Bool?.none

    var player1Challenges = Bool?.none

    var rematchGameId = String?.none

    var word = ""

    var isSuperghost: Bool

    var createdAt: String = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZ"
        return formatter.string(from: Date())
    }()
}
func description(for game: Game) -> String {
    """
    Game ID: \(game.id)
    Player 1 ID: \(game.player1Id)
    Player 1 Profile: \(game.player1profile)
    Player 2 ID: \(game.player2Id.isEmpty ? "Not assigned" : game.player2Id)
    Player 2 Profile: \(game.player2profile.map { "\($0)" } ?? "Not assigned")
    Blocking Move for Player 1: \(game.isBlockingMoveForPlayerOne ? "Yes" : "No")
    Player 1 Wins: \(game.player1Wins.map { $0 ? "Yes" : "No" } ?? "Not decided")
    Player 1 Challenges: \(game.player1Challenges.map { $0 ? "Yes" : "No" } ?? "Not decided")
    Rematch Game ID: \(game.rematchGameId ?? "None")
    Word: \(game.word.isEmpty ? "None" : game.word)
    Is Superghost: \(game.isSuperghost ? "Yes" : "No")
    Created At: \(game.createdAt)
    """
}
struct PlayerProfile: Equatable, Content {
    var image: String? //base 64 encoded
    var rank: Int?
    var name: String
}
struct GameMove: Content {
    var word: String?

    var player1Id: String?
    var player1Profile: PlayerProfile?

    var player2Id: String?
    var player2Profile: PlayerProfile?

    var isBlockingMoveForPlayerOne : Bool

    var player1Wins = Bool?.none

    var player1Challenges = Bool?.none

    var rematchGameId = String?.none

    var isSuperghost: Bool?
}
