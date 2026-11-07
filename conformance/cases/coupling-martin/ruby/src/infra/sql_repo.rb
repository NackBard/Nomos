module Shop
  module Infra
    class SqlRepo
      include Domain::Repo

      def cache
        @cache ||= Domain::Entity.new
      end
    end
  end
end
